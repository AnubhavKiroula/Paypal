/** Token usage for one call, or summed across calls. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export type StopReason = 'end' | 'max_tokens' | 'refusal' | 'context_window_exceeded' | 'other';

/**
 * Transport-level request. Deliberately has no tools, tool_choice, functions or sampling
 * parameters: adapters cannot send what the type cannot express (ADR 0004).
 */
export interface ProviderRequest {
  system: string;
  userText: string;
  maxOutputTokens: number;
  /** Milliseconds left in the caller's overall deadline. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Strict JSON Schema for native structured output. Bounds are not enforced by every provider. */
  responseJsonSchema?: Record<string, unknown>;
}

export interface ProviderResponse {
  text: string;
  usage: Usage;
  /** The model that actually answered. */
  model: string;
  stopReason: StopReason;
}

/** Transport only: no parsing, validation, retries or logging. Throws ProviderError on failure. */
export interface ProviderAdapter {
  readonly provider: string;
  readonly model: string;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
}
