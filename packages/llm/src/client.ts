import { createHash } from 'node:crypto';
import { z } from 'zod';
import { LlmError, type LlmErrorCode, ProviderError, SchemaNotSupportedError } from './errors.js';
import { type Logger, noopLogger } from './logger.js';
import { type NonceSource, type PromptPart, UNTRUSTED_DATA_NOTICE, cryptoNonceSource, renderUserText } from './prompt.js';
import type { ProviderAdapter, ProviderRequest, ProviderResponse, Usage } from './provider.js';
import { AbortedError, type Clock, type Sleep, defaultSleep, systemClock } from './time.js';

/** Provider calls per generateStructured() call, whatever the reason for each. */
export const MAX_TOTAL_ATTEMPTS = 4;
/** Calls spent delivering any one prompt (initial, repair or escalation) through transport errors. */
export const MAX_TRANSPORT_ATTEMPTS_PER_PROMPT = 3;
export const BACKOFF_BASE_MS = 250;
export const BACKOFF_CAP_MS = 4_000;
export const DEFAULT_MAX_OUTPUT_TOKENS_CEILING = 16_000;

export interface LlmClientOptions {
  adapter: ProviderAdapter;
  /** Default overall deadline for one generateStructured() call, retries included. */
  timeoutMs: number;
  maxOutputTokens: number;
  /** Upper bound when a max_tokens stop is retried with a larger budget. */
  maxOutputTokensCeiling?: number;
  logger?: Logger;
  clock?: Clock;
  sleep?: Sleep;
  /** Returns [0, 1). Drives backoff jitter. */
  random?: () => number;
  nonceSource?: NonceSource;
}

export interface StructuredRequest<S extends z.ZodType> {
  /** Short identifier for logs, e.g. "purchase_intent". */
  schemaName: string;
  /** Must be transform-free and strict at every level. */
  schema: S;
  /** Trusted instructions. */
  system: string;
  parts: readonly PromptPart[];
  timeoutMs?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface StructuredResult<T> {
  data: T;
  usage: Usage;
  attempts: number;
  model: string;
  latencyMs: number;
}

type Phase = 'initial' | 'repair' | 'escalation';
type PromptPieces = Pick<ProviderRequest, 'system' | 'userText' | 'maxOutputTokens' | 'responseJsonSchema'>;
type Validation<T> = { ok: true; data: T } | { ok: false; code: 'SCHEMA_INVALID' | 'EMPTY_OUTPUT'; note: string };

interface RunState {
  readonly schemaName: string;
  readonly deadline: number;
  readonly signal: AbortSignal | undefined;
  attempts: number;
  usage: Usage;
  model: string;
  promptSha256: string | undefined;
}

const NEVER = new Promise<never>(() => undefined);

export class LlmClient {
  private readonly adapter: ProviderAdapter;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly sleep: Sleep;
  private readonly random: () => number;
  private readonly nonceSource: NonceSource;
  private readonly ceiling: number;

  constructor(private readonly options: LlmClientOptions) {
    this.adapter = options.adapter;
    this.logger = options.logger ?? noopLogger;
    this.clock = options.clock ?? systemClock;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.nonceSource = options.nonceSource ?? cryptoNonceSource;
    this.ceiling = options.maxOutputTokensCeiling ?? DEFAULT_MAX_OUTPUT_TOKENS_CEILING;
  }

  async generateStructured<S extends z.ZodType>(request: StructuredRequest<S>): Promise<StructuredResult<z.output<S>>> {
    const responseJsonSchema = toStrictJsonSchema(request.schemaName, request.schema);
    const started = this.clock.now();
    const state: RunState = {
      schemaName: request.schemaName,
      deadline: started + (request.timeoutMs ?? this.options.timeoutMs),
      signal: request.signal,
      attempts: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      model: this.adapter.model,
      promptSha256: undefined,
    };
    const system = request.parts.some((part) => part.kind === 'untrusted')
      ? `${request.system}\n\n${UNTRUSTED_DATA_NOTICE}`
      : request.system;
    let maxOutputTokens = Math.min(request.maxOutputTokens ?? this.options.maxOutputTokens, this.ceiling);
    let repairNote: string | undefined;
    let escalated = false;
    let phase: Phase = 'initial';

    try {
      for (;;) {
        const response = await this.callWithRetries(state, phase, () => ({
          system,
          userText: renderUserText(request.parts, this.nonceSource, repairNote),
          maxOutputTokens,
          responseJsonSchema,
        }));

        // The stop reason is checked before parsing: refused or truncated output is never accepted.
        if (response.stopReason === 'refusal') throw new LlmError('REFUSAL', state.attempts);
        if (response.stopReason === 'context_window_exceeded') throw new LlmError('CONTEXT_TOO_LARGE', state.attempts);
        if (response.stopReason === 'max_tokens') {
          if (!escalated && maxOutputTokens < this.ceiling && state.attempts < MAX_TOTAL_ATTEMPTS) {
            maxOutputTokens = Math.min(maxOutputTokens * 2, this.ceiling);
            escalated = true;
            phase = 'escalation';
            continue;
          }
          throw new LlmError('OUTPUT_TRUNCATED', state.attempts);
        }

        const validation = validate(request.schema, response.text);
        if (validation.ok) {
          this.logResult(state, 'OK', started, response.text.length);
          return {
            data: validation.data,
            usage: state.usage,
            attempts: state.attempts,
            model: state.model,
            latencyMs: this.clock.now() - started,
          };
        }
        if (repairNote === undefined && state.attempts < MAX_TOTAL_ATTEMPTS) {
          repairNote = `${validation.note}\nReply again with only a JSON object that matches the schema.`;
          phase = 'repair';
          continue;
        }
        throw new LlmError(validation.code, state.attempts);
      }
    } catch (error) {
      if (error instanceof LlmError) this.logResult(state, error.code, started, 0);
      throw error;
    }
  }

  private async callWithRetries(state: RunState, phase: Phase, build: () => PromptPieces): Promise<ProviderResponse> {
    for (let transportAttempt = 1; ; transportAttempt++) {
      if (state.signal?.aborted) throw new LlmError('ABORTED', state.attempts);
      const remaining = state.deadline - this.clock.now();
      if (remaining <= 0) throw new LlmError('PROVIDER_TIMEOUT', state.attempts);

      const pieces = build();
      const promptSha256 = sha256(pieces.system, pieces.userText);
      state.promptSha256 ??= promptSha256;
      state.attempts++;
      this.logger.debug('llm.attempt', {
        provider: this.adapter.provider,
        model: this.adapter.model,
        schema: state.schemaName,
        attempt: state.attempts,
        phase,
        promptSha256,
        systemChars: pieces.system.length,
        userChars: pieces.userText.length,
        maxOutputTokens: pieces.maxOutputTokens,
      });

      try {
        const response = await this.invoke({ ...pieces, timeoutMs: remaining }, remaining, state.signal);
        state.usage.inputTokens += response.usage.inputTokens;
        state.usage.outputTokens += response.usage.outputTokens;
        state.model = response.model;
        return response;
      } catch (error) {
        // Anything that is not a ProviderError is a bug in the adapter: surface it unchanged.
        if (!(error instanceof ProviderError)) throw error;
        if (error.code === 'ABORTED') throw new LlmError('ABORTED', state.attempts, error.details);

        const exhausted =
          !error.retryable ||
          transportAttempt >= MAX_TRANSPORT_ATTEMPTS_PER_PROMPT ||
          state.attempts >= MAX_TOTAL_ATTEMPTS;
        const delay = error.details.retryAfterMs ?? this.backoff(transportAttempt);
        if (exhausted || this.clock.now() + delay >= state.deadline) {
          throw new LlmError(error.code, state.attempts, error.details);
        }
        try {
          await this.sleep(delay, state.signal);
        } catch (sleepError) {
          if (sleepError instanceof AbortedError) throw new LlmError('ABORTED', state.attempts);
          throw sleepError;
        }
      }
    }
  }

  /** One adapter call, bounded by the deadline and the caller's signal even if the adapter ignores both. */
  private async invoke(
    request: Omit<ProviderRequest, 'signal'>,
    remaining: number,
    callerSignal: AbortSignal | undefined,
  ): Promise<ProviderResponse> {
    const call = new AbortController();
    const timer = new AbortController();
    let rejectAborted: (error: ProviderError) => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = reject;
    });
    const onCallerAbort = () => {
      call.abort();
      rejectAborted(new ProviderError('ABORTED'));
    };
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    const timedOut = this.sleep(remaining, timer.signal).then(
      () => {
        call.abort();
        throw new ProviderError('PROVIDER_TIMEOUT');
      },
      () => NEVER,
    );

    try {
      return await Promise.race([this.adapter.complete({ ...request, signal: call.signal }), timedOut, aborted]);
    } finally {
      timer.abort();
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  }

  /** Full jitter: uniform in [0, min(cap, base * 2^(n-1))). */
  private backoff(transportAttempt: number): number {
    return Math.floor(this.random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (transportAttempt - 1)));
  }

  private logResult(state: RunState, outcome: 'OK' | LlmErrorCode, started: number, outputChars: number): void {
    const fields = {
      provider: this.adapter.provider,
      model: state.model,
      schema: state.schemaName,
      attempts: state.attempts,
      outcome,
      latencyMs: this.clock.now() - started,
      inputTokens: state.usage.inputTokens,
      outputTokens: state.usage.outputTokens,
      promptSha256: state.promptSha256 ?? null,
      outputChars,
    };
    if (outcome === 'OK') this.logger.info('llm.result', fields);
    else this.logger.warn('llm.result', fields);
  }
}

function sha256(system: string, userText: string): string {
  return createHash('sha256').update(system).update('\n--- user ---\n').update(userText).digest('hex');
}

/**
 * The schema must be transform-free (output mode throws on transforms) and closed at every level.
 * Strictness is checked in input mode: output mode marks even non-strict objects closed.
 */
function toStrictJsonSchema(schemaName: string, schema: z.ZodType): Record<string, unknown> {
  let input: Record<string, unknown>;
  try {
    z.toJSONSchema(schema, { unrepresentable: 'throw', io: 'output' });
    input = z.toJSONSchema(schema, { unrepresentable: 'throw', io: 'input' });
  } catch (error) {
    throw new SchemaNotSupportedError(schemaName, error instanceof Error ? error.message : 'not representable');
  }
  if (input['type'] !== 'object') throw new SchemaNotSupportedError(schemaName, 'the root must be an object');
  assertClosedObjects(schemaName, input);
  return input;
}

function assertClosedObjects(schemaName: string, node: unknown): void {
  if (Array.isArray(node)) {
    for (const child of node) assertClosedObjects(schemaName, child);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  if (record['type'] === 'object' && record['additionalProperties'] !== false) {
    throw new SchemaNotSupportedError(schemaName, 'every object must be strict');
  }
  for (const child of Object.values(record)) assertClosedObjects(schemaName, child);
}

function validate<S extends z.ZodType>(schema: S, text: string): Validation<z.output<S>> {
  if (text.trim() === '') return { ok: false, code: 'EMPTY_OUTPUT', note: 'Your previous reply was empty.' };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, code: 'SCHEMA_INVALID', note: 'Your previous reply was not valid JSON.' };
  }
  const parsed = schema.safeParse(json);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, code: 'SCHEMA_INVALID', note: summarizeIssues(parsed.error) };
}

const SAFE_SEGMENT = /^[A-Za-z0-9_]{1,40}$/;

/**
 * Issue codes and schema paths only. Values and messages are never included, and unknown keys are
 * counted rather than named: both come from the model and may echo injected text.
 */
function summarizeIssues(error: z.ZodError): string {
  const lines = error.issues.slice(0, 10).map((issue) => {
    const path =
      issue.path.length === 0
        ? '(root)'
        : issue.path
            .map((segment) =>
              typeof segment === 'number' ? `[${segment}]` : typeof segment === 'string' && SAFE_SEGMENT.test(segment) ? segment : '?',
            )
            .join('.');
    return issue.code === 'unrecognized_keys'
      ? `- ${path}: ${issue.keys.length} unexpected field(s)`
      : `- ${path}: ${issue.code}`;
  });
  return `Your previous reply did not match the required JSON schema:\n${lines.join('\n')}`;
}
