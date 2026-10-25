/** Errors an adapter may raise. Everything else the client derives from the response. */
export type ProviderErrorCode =
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_AUTH'
  | 'PROVIDER_BAD_REQUEST'
  | 'CONTEXT_TOO_LARGE'
  | 'ABORTED';

export type LlmErrorCode =
  | ProviderErrorCode
  | 'SCHEMA_INVALID'
  | 'EMPTY_OUTPUT'
  | 'REFUSAL'
  | 'OUTPUT_TRUNCATED';

const RETRYABLE: ReadonlySet<LlmErrorCode> = new Set(['PROVIDER_TIMEOUT', 'PROVIDER_RATE_LIMITED', 'PROVIDER_UNAVAILABLE']);

// Fixed, safe messages: never prompt text, model output or provider payloads.
const MESSAGES: Record<LlmErrorCode, string> = {
  SCHEMA_INVALID: 'Model output failed schema validation',
  EMPTY_OUTPUT: 'Model returned no output',
  REFUSAL: 'Model declined the request',
  OUTPUT_TRUNCATED: 'Model output hit the token limit',
  CONTEXT_TOO_LARGE: 'Request exceeds the model context window',
  PROVIDER_TIMEOUT: 'Provider call timed out',
  PROVIDER_RATE_LIMITED: 'Provider rate limit reached',
  PROVIDER_UNAVAILABLE: 'Provider unavailable',
  PROVIDER_AUTH: 'Provider rejected the credentials',
  PROVIDER_BAD_REQUEST: 'Provider rejected the request',
  ABORTED: 'Request aborted',
};

export function isRetryable(code: LlmErrorCode): boolean {
  return RETRYABLE.has(code);
}

export interface ProviderErrorDetails {
  retryAfterMs?: number;
  status?: number;
  requestId?: string;
}

/** Raised by adapters. Carries no provider message, which could echo request content. */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly details: ProviderErrorDetails;

  constructor(code: ProviderErrorCode, details: ProviderErrorDetails = {}) {
    super(MESSAGES[code]);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = isRetryable(code);
    this.details = details;
  }
}

/** The only error LlmClient raises for provider or model failures. */
export class LlmError extends Error {
  readonly code: LlmErrorCode;
  /** Whether the caller may sensibly try again later. */
  readonly retryable: boolean;
  /** Provider calls made before failing. */
  readonly attempts: number;
  readonly status: number | undefined;
  readonly requestId: string | undefined;

  constructor(code: LlmErrorCode, attempts: number, details: ProviderErrorDetails = {}) {
    super(MESSAGES[code]);
    this.name = 'LlmError';
    this.code = code;
    this.retryable = isRetryable(code);
    this.attempts = attempts;
    this.status = details.status;
    this.requestId = details.requestId;
  }
}

/** Programming error: the response schema cannot be sent as a strict JSON Schema. */
export class SchemaNotSupportedError extends Error {
  constructor(schemaName: string, reason: string) {
    super(`Schema "${schemaName}" is not usable for structured output: ${reason}`);
    this.name = 'SchemaNotSupportedError';
  }
}
