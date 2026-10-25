import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk';
import { transformJSONSchema } from '@anthropic-ai/sdk/lib/transform-json-schema';
import type { Message, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages';
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

    let message: Message;
    try {
      message = await this.createMessage(params, options);
    } catch (error) {
      throw toProviderError(error, this.clock.now());
    }
    return {
      text: message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(''),
      usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
      model: message.model,
      stopReason: mapStopReason(message.stop_reason),
    };
  }
}

function mapStopReason(reason: Message['stop_reason']): StopReason {
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

/** Maps SDK errors to ProviderError. Anything else is a bug and is returned unchanged for rethrow. */
export function toProviderError(error: unknown, now: number): unknown {
  // Subclasses before their parents: abort and timeout extend APIError / APIConnectionError.
  if (error instanceof APIUserAbortError) return new ProviderError('ABORTED');
  if (error instanceof APIConnectionTimeoutError) return new ProviderError('PROVIDER_TIMEOUT');
  if (error instanceof APIConnectionError) return new ProviderError('PROVIDER_UNAVAILABLE');
  if (!(error instanceof APIError)) return error;

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
  const ms = Number(headers?.get('retry-after-ms') ?? Number.NaN);
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const raw = headers?.get('retry-after');
  if (raw === null || raw === undefined || raw.trim() === '') return undefined;
  const seconds = Number(raw);
  // A numeric value never falls through to Date.parse, which leniently accepts strings such as "-1".
  if (!Number.isNaN(seconds)) return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
