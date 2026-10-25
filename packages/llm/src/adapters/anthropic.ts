import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AnthropicError,
} from '@anthropic-ai/sdk';
import { transformJSONSchema } from '@anthropic-ai/sdk/lib/transform-json-schema';
import type { Message, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages';
import { z } from 'zod';
import type { LlmConfig, Secret } from '../config.js';
import { ProviderError, type ProviderErrorDetails } from '../errors.js';
import type { ProviderAdapter, ProviderRequest, ProviderResponse, StopReason } from '../provider.js';
import { type Clock, systemClock } from '../time.js';

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

export interface MessageRequestOptions {
  timeout: number;
  maxRetries: number;
  signal?: AbortSignal;
}

/** The single SDK call the adapter makes. Injectable so tests never touch the network. */
export type CreateMessage = (params: MessageCreateParamsNonStreaming, options: MessageRequestOptions) => Promise<Message>;

/**
 * Every option that the SDK would otherwise read from the environment is pinned here:
 * credentials (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN), base URL (ANTHROPIC_BASE_URL),
 * logging (ANTHROPIC_LOG, which at debug level can print request bodies) and OpenTelemetry
 * content capture. Retries are disabled: LlmClient owns the retry policy and its bounds.
 * ANTHROPIC_CUSTOM_HEADERS cannot be disabled through options; see docs/llm-layer.md.
 */
export function createAnthropicClient(apiKey: Secret, baseURL: string = ANTHROPIC_BASE_URL): Anthropic {
  return new Anthropic({
    apiKey: apiKey.reveal(),
    authToken: null,
    baseURL,
    maxRetries: 0,
    logLevel: 'off',
    openTelemetry: false,
  });
}

/** The fields the adapter reads. A 200 can still carry another body, such as a gateway page. */
const MessageShape = z.object({
  model: z.string(),
  stop_reason: z.string().nullable(),
  usage: z.object({ input_tokens: z.int().nonnegative(), output_tokens: z.int().nonnegative() }),
  content: z.array(
    z.union([
      z.object({ type: z.literal('text'), text: z.string() }),
      z.object({ type: z.string().refine((type) => type !== 'text') }),
    ]),
  ),
});

export interface AnthropicAdapterOptions {
  model: string;
  createMessage: CreateMessage;
  clock?: Clock;
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly provider = 'anthropic';
  readonly model: string;
  private readonly createMessage: CreateMessage;
  private readonly clock: Clock;

  constructor(options: AnthropicAdapterOptions) {
    this.model = options.model;
    this.createMessage = options.createMessage;
    this.clock = options.clock ?? systemClock;
  }

  static fromConfig(config: LlmConfig): AnthropicAdapter {
    const client = createAnthropicClient(config.apiKey);
    return new AnthropicAdapter({
      model: config.model,
      createMessage: (params, options) => client.messages.create(params, options),
    });
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    // Fields are picked one by one, never spread from the request: nothing else can reach the wire.
    const params: MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: request.maxOutputTokens,
      system: request.system,
      messages: [{ role: 'user', content: request.userText }],
    };
    if (request.responseJsonSchema !== undefined) {
      // The SDK helper moves keywords the API does not enforce (bounds, patterns) into descriptions,
      // so bounds are only guaranteed by LlmClient's Zod validation.
      params.output_config = { format: { type: 'json_schema', schema: transformJSONSchema(request.responseJsonSchema) } };
    }
    const options: MessageRequestOptions = { timeout: request.timeoutMs, maxRetries: 0 };
    if (request.signal !== undefined) options.signal = request.signal;

    let raw: unknown;
    try {
      raw = await this.createMessage(params, options);
    } catch (error) {
      throw request.signal?.aborted ? new ProviderError('ABORTED') : toProviderError(error, this.clock.now());
    }
    const message = MessageShape.safeParse(raw);
    // A 200 whose body is not a Message is treated like a gateway failure: transient, and retried.
    if (!message.success) throw new ProviderError('PROVIDER_UNAVAILABLE');
    const { content, usage, model, stop_reason } = message.data;
    return {
      text: content.flatMap((block) => ('text' in block ? [block.text] : [])).join(''),
      usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
      model,
      stopReason: mapStopReason(stop_reason),
    };
  }
}

function mapStopReason(reason: string | null): StopReason {
  switch (reason) {
    case 'end_turn':
      return 'end';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    case 'model_context_window_exceeded':
      return 'context_window_exceeded';
    default:
      return 'other';
  }
}

/**
 * Maps any rejection of the SDK call to a ProviderError; the original error is never attached. A
 * plain AnthropicError is the SDK refusing the request before sending it. Anything else escaped the
 * SDK while it read the response body (a connection reset mid-body, say) and counts as an outage.
 */
export function toProviderError(error: unknown, now: number): ProviderError {
  // Subclasses before their parents: abort and timeout extend APIError / APIConnectionError.
  if (error instanceof APIUserAbortError) return new ProviderError('ABORTED');
  if (error instanceof APIConnectionTimeoutError) return new ProviderError('PROVIDER_TIMEOUT');
  if (error instanceof APIConnectionError) return new ProviderError('PROVIDER_UNAVAILABLE');
  if (!(error instanceof APIError)) {
    return new ProviderError(error instanceof AnthropicError ? 'PROVIDER_BAD_REQUEST' : 'PROVIDER_UNAVAILABLE');
  }

  // `instanceof APIError` narrows to APIError<any, any, any>: read each field as unknown and narrow.
  const rawStatus: unknown = error.status;
  const rawHeaders: unknown = error.headers;
  const rawRequestId: unknown = error.requestID;
  const status = typeof rawStatus === 'number' ? rawStatus : 0;
  const details: ProviderErrorDetails = { status };
  if (typeof rawRequestId === 'string' && rawRequestId !== '') details.requestId = rawRequestId;
  const retryAfterMs = parseRetryAfterMs(rawHeaders instanceof Headers ? rawHeaders : undefined, now);
  if (retryAfterMs !== undefined) details.retryAfterMs = retryAfterMs;

  if (status === 401 || status === 403) return new ProviderError('PROVIDER_AUTH', details);
  if (status === 429) return new ProviderError('PROVIDER_RATE_LIMITED', details);
  if (status === 408) return new ProviderError('PROVIDER_TIMEOUT', details);
  if (status === 409 || status >= 500) return new ProviderError('PROVIDER_UNAVAILABLE', details);
  // VERIFY: the API reports an oversized prompt as 413, or as 400 "prompt is too long".
  if (status === 413 || (status === 400 && /prompt is too long/i.test(error.message))) {
    return new ProviderError('CONTEXT_TOO_LARGE', details);
  }
  return new ProviderError('PROVIDER_BAD_REQUEST', details);
}

/** Supports retry-after-ms, retry-after in seconds, and retry-after as an HTTP date. */
export function parseRetryAfterMs(headers: Headers | undefined, now: number): number | undefined {
  const rawMs = headers?.get('retry-after-ms')?.trim();
  // A blank retry-after-ms counts as absent, as a blank retry-after does; Number('') would be 0.
  const ms = rawMs ? Number(rawMs) : Number.NaN;
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const raw = headers?.get('retry-after');
  if (raw === null || raw === undefined || raw.trim() === '') return undefined;
  const seconds = Number(raw);
  // A numeric value never falls through to Date.parse, which leniently accepts strings such as "-1".
  if (!Number.isNaN(seconds)) return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
