import { z } from 'zod';
import type { LlmConfig, ReasoningEffort, Secret } from '../config.js';
import { ProviderError, type ProviderErrorCode, type ProviderErrorDetails } from '../errors.js';
import type { ProviderAdapter, ProviderRequest, ProviderResponse, StopReason } from '../provider.js';
import { AbortedError, type Clock, defaultSleep, type Sleep, systemClock } from '../time.js';
import { parseRetryAfterMs, trimTrailingSlashes } from './http.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface OpenAICompatibleAdapterOptions {
  /** Chat Completions base URL without a trailing path, e.g. https://integrate.api.nvidia.com/v1. */
  baseUrl: string;
  model: string;
  apiKey: Secret;
  reasoningEffort?: ReasoningEffort;
  /** Client-side throttle. Unset: no spacing between calls. */
  requestsPerMinute?: number;
  /** Injectable so tests never touch the network. */
  fetch?: FetchLike;
  clock?: Clock;
  sleep?: Sleep;
}

/** The fields the adapter reads. A 200 can still carry another body, such as a gateway page. */
const CompletionShape = z.object({
  model: z.string(),
  choices: z
    .array(z.object({ finish_reason: z.string().nullable().optional(), message: z.object({ content: z.string().nullable().optional() }) }))
    .min(1),
  usage: z.object({ prompt_tokens: z.int().nonnegative(), completion_tokens: z.int().nonnegative() }).optional(),
});

/**
 * Chat Completions over plain fetch, for OpenAI-compatible providers (NVIDIA's API catalog, Ollama, ...).
 * No SDK, so nothing is read from the environment. The request has no tools, functions or sampling fields:
 * the body is built field by field from ProviderRequest, which cannot express them (ADR 0004). Retries belong
 * to LlmClient; this adapter only spaces calls (requestsPerMinute) and reports 429 with Retry-After.
 */
export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly provider = 'openai-compatible';
  readonly model: string;
  readonly #endpoint: string;
  readonly #apiKey: Secret;
  readonly #reasoningEffort: ReasoningEffort | undefined;
  readonly #intervalMs: number;
  readonly #fetch: FetchLike;
  readonly #clock: Clock;
  readonly #sleep: Sleep;
  #nextSlot = 0;

  constructor(options: OpenAICompatibleAdapterOptions) {
    this.model = options.model;
    this.#endpoint = `${trimTrailingSlashes(options.baseUrl)}/chat/completions`;
    this.#apiKey = options.apiKey;
    this.#reasoningEffort = options.reasoningEffort;
    this.#intervalMs = options.requestsPerMinute ? Math.ceil(60_000 / options.requestsPerMinute) : 0;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#clock = options.clock ?? systemClock;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  static fromConfig(config: Extract<LlmConfig, { provider: 'openai-compatible' }>): OpenAICompatibleAdapter {
    return new OpenAICompatibleAdapter({
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: config.apiKey,
      requestsPerMinute: config.requestsPerMinute,
      ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
    });
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    await this.#throttle(request.signal);

    // Fields are picked one by one, never spread from the request: nothing else can reach the wire.
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: request.maxOutputTokens,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.userText },
      ],
    };
    if (request.responseJsonSchema !== undefined) {
      body['response_format'] = { type: 'json_schema', json_schema: { name: 'output', strict: true, schema: request.responseJsonSchema } };
    }
    if (this.#reasoningEffort !== undefined) body['reasoning_effort'] = this.#reasoningEffort;

    const timeout = AbortSignal.timeout(request.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    let raw: unknown;
    try {
      const response = await this.#fetch(this.#endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.#apiKey.reveal()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) throw await toProviderError(response, this.#clock.now());
      raw = await response.json();
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (request.signal?.aborted) throw new ProviderError('ABORTED');
      if (error instanceof DOMException && error.name === 'TimeoutError') throw new ProviderError('PROVIDER_TIMEOUT');
      // Network failures, and a 200 whose body is not JSON (a gateway page): transient, and retried.
      throw new ProviderError('PROVIDER_UNAVAILABLE');
    }

    const completion = CompletionShape.safeParse(raw);
    if (!completion.success) throw new ProviderError('PROVIDER_UNAVAILABLE');
    const { model, choices, usage } = completion.data;
    const choice = choices[0];
    return {
      // Only the answer: reasoning text (reasoning_content) is never read.
      text: choice?.message.content ?? '',
      usage: { inputTokens: usage?.prompt_tokens ?? 0, outputTokens: usage?.completion_tokens ?? 0 },
      model,
      stopReason: mapFinishReason(choice?.finish_reason ?? null),
    };
  }

  /** Reserves the next start slot, so even concurrent calls are spaced `intervalMs` apart. */
  async #throttle(signal: AbortSignal | undefined): Promise<void> {
    if (this.#intervalMs === 0) return;
    const now = this.#clock.now();
    const slot = Math.max(now, this.#nextSlot);
    this.#nextSlot = slot + this.#intervalMs;
    if (slot === now) return;
    try {
      await this.#sleep(slot - now, signal);
    } catch (error) {
      if (error instanceof AbortedError) throw new ProviderError('ABORTED');
      throw error;
    }
  }
}

function mapFinishReason(reason: string | null): StopReason {
  switch (reason) {
    case 'stop':
      return 'end';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}

/** Maps an HTTP error. The body is read only to spot a context-length error, and is never attached. */
async function toProviderError(response: Response, now: number): Promise<ProviderError> {
  const { status } = response;
  const details: ProviderErrorDetails = { status };
  const requestId = response.headers.get('x-request-id');
  if (requestId) details.requestId = requestId;
  const retryAfterMs = parseRetryAfterMs(response.headers, now);
  if (retryAfterMs !== undefined) details.retryAfterMs = retryAfterMs;

  let code: ProviderErrorCode = 'PROVIDER_BAD_REQUEST';
  if (status === 401 || status === 403) code = 'PROVIDER_AUTH';
  else if (status === 429) code = 'PROVIDER_RATE_LIMITED';
  else if (status === 408) code = 'PROVIDER_TIMEOUT';
  else if (status === 409 || status >= 500) code = 'PROVIDER_UNAVAILABLE';
  else if (status === 413) code = 'CONTEXT_TOO_LARGE';
  else if (status === 400) {
    const text = await response.text().catch(() => '');
    if (/context length|context window|too many tokens|prompt is too long/i.test(text.slice(0, 2_000))) code = 'CONTEXT_TOO_LARGE';
  }
  return new ProviderError(code, details);
}
