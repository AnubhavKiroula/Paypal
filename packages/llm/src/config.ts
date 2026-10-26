import { inspect } from 'node:util';
import { z } from 'zod';

const REDACTED = '[REDACTED]';

/** Holds a credential. Every serialization path prints [REDACTED]; only reveal() returns the value. */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

export interface LlmConfig {
  provider: 'anthropic';
  model: string;
  apiKey: Secret;
  timeoutMs: number;
  maxOutputTokens: number;
}

/** Names only, never values: a value could be the key itself. */
export class LlmConfigError extends Error {
  readonly variables: readonly string[];

  constructor(variables: readonly string[]) {
    super(`Invalid LLM configuration: ${variables.join(', ')}`);
    this.name = 'LlmConfigError';
    this.variables = variables;
  }
}

const emptyAsUnset = (value: unknown) => (value === '' ? undefined : value);

const EnvSchema = z.object({
  LLM_PROVIDER: z.preprocess(emptyAsUnset, z.enum(['anthropic']).default('anthropic')),
  LLM_MODEL: z.preprocess(emptyAsUnset, z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/).default('claude-opus-5-5')),
  ANTHROPIC_API_KEY: z.preprocess(emptyAsUnset, z.string().min(1)),
  LLM_TIMEOUT_MS: z.preprocess(emptyAsUnset, z.coerce.number().int().min(1_000).max(120_000).default(60_000)),
  LLM_MAX_OUTPUT_TOKENS: z.preprocess(emptyAsUnset, z.coerce.number().int().min(256).max(16_000).default(8_192)),
});

/**
 * The only place the LLM layer reads configuration or the API key. Reads the given env object
 * only, so callers and tests control exactly what is visible.
 */
export function loadLlmConfig(env: Readonly<Record<string, string | undefined>> = process.env): LlmConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const variables = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? 'env')))].sort();
    throw new LlmConfigError(variables);
  }
  return {
    provider: parsed.data.LLM_PROVIDER,
    model: parsed.data.LLM_MODEL,
    apiKey: new Secret(parsed.data.ANTHROPIC_API_KEY),
    timeoutMs: parsed.data.LLM_TIMEOUT_MS,
    maxOutputTokens: parsed.data.LLM_MAX_OUTPUT_TOKENS,
  };
}
