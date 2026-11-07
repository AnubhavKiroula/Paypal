import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmConfigError, Secret, loadLlmConfig } from '../src/config.js';

const KEY = 'sk-test-PLACEHOLDER-not-a-real-key';
const env = (overrides: Record<string, string | undefined> = {}) => ({ ANTHROPIC_API_KEY: KEY, ...overrides });

function configError(input: Record<string, string | undefined>): LlmConfigError {
  try {
    loadLlmConfig(input);
  } catch (error) {
    if (error instanceof LlmConfigError) return error;
    throw error;
  }
  throw new Error('expected loadLlmConfig to throw');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadLlmConfig', () => {
  it('applies documented defaults when only the key is set', () => {
    const config = loadLlmConfig(env());
    expect(config).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      timeoutMs: 120_000,
      maxOutputTokens: 8_192,
    });
    expect(config.apiKey.reveal()).toBe(KEY);
  });

  it('reads explicit values, coercing numbers', () => {
    const config = loadLlmConfig(
      env({ LLM_MODEL: 'claude-haiku-5-5', LLM_TIMEOUT_MS: '15000', LLM_MAX_OUTPUT_TOKENS: '4096' }),
    );
    expect(config).toMatchObject({ model: 'claude-haiku-5-5', timeoutMs: 15_000, maxOutputTokens: 4_096 });
  });

  it('treats empty strings, as copied from .env.example, as unset', () => {
    expect(loadLlmConfig(env({ LLM_MODEL: '', LLM_TIMEOUT_MS: '' }))).toMatchObject({
      model: 'claude-opus-5-5',
      timeoutMs: 120_000,
    });
    expect(configError({ ANTHROPIC_API_KEY: '' }).variables).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('requires the API key', () => {
    expect(configError({}).variables).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('reads only the env object it is given, never process.env behind it', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', KEY);
    expect(configError({}).variables).toEqual(['ANTHROPIC_API_KEY']);
  });

  it.each([
    ['an unknown provider', { LLM_PROVIDER: 'openai' }, 'LLM_PROVIDER'],
    ['a model id with spaces', { LLM_MODEL: 'bad model!' }, 'LLM_MODEL'],
    ['a non-numeric timeout', { LLM_TIMEOUT_MS: 'abc' }, 'LLM_TIMEOUT_MS'],
    ['a timeout below the floor', { LLM_TIMEOUT_MS: '500' }, 'LLM_TIMEOUT_MS'],
    ['a fractional timeout', { LLM_TIMEOUT_MS: '1500.5' }, 'LLM_TIMEOUT_MS'],
    ['too many output tokens', { LLM_MAX_OUTPUT_TOKENS: '99999' }, 'LLM_MAX_OUTPUT_TOKENS'],
  ])('rejects %s, naming the variable but not its value', (_label, overrides, variable) => {
    const error = configError(env(overrides));
    expect(error.variables).toEqual([variable]);
    for (const value of Object.values(overrides)) {
      expect(error.message).not.toContain(value);
    }
  });
});

describe('loadLlmConfig: openai-compatible provider', () => {
  const NVIDIA = 'https://integrate.api.nvidia.com/v1';
  const compat = (overrides: Record<string, string | undefined> = {}) => ({
    LLM_PROVIDER: 'openai-compatible',
    LLM_BASE_URL: NVIDIA,
    LLM_MODEL: 'mistralai/mistral-large-4-1t-a52b',
    LLM_API_KEY: KEY,
    ...overrides,
  });

  it('reads base URL, model and key, with throttle and timeout defaults and no reasoning effort', () => {
    const config = loadLlmConfig(compat());
    expect(config).toMatchObject({
      provider: 'openai-compatible',
      baseUrl: NVIDIA,
      model: 'mistralai/mistral-large-4-1t-a52b',
      timeoutMs: 120_000,
      requestsPerMinute: 30,
    });
    expect(config.provider === 'openai-compatible' && config.reasoningEffort).toBeUndefined();
    expect(config.apiKey.reveal()).toBe(KEY);
  });

  it('reads the reasoning effort and requests-per-minute when set', () => {
    expect(loadLlmConfig(compat({ LLM_REASONING_EFFORT: 'low', LLM_REQUESTS_PER_MINUTE: '20' }))).toMatchObject({
      reasoningEffort: 'low',
      requestsPerMinute: 20,
    });
  });

  it('needs its own variables, and never the Anthropic key', () => {
    expect(configError({ LLM_PROVIDER: 'openai-compatible' }).variables).toEqual(['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL']);
    expect(configError({ LLM_PROVIDER: 'openai-compatible', ANTHROPIC_API_KEY: KEY }).variables).not.toContain('ANTHROPIC_API_KEY');
  });

  it.each([
    ['a plain-http remote base URL', { LLM_BASE_URL: 'http://integrate.api.nvidia.com/v1' }, 'LLM_BASE_URL'],
    ['a base URL with credentials', { LLM_BASE_URL: 'https://user:pass@example.com/v1' }, 'LLM_BASE_URL'],
    ['an unknown reasoning effort', { LLM_REASONING_EFFORT: 'max' }, 'LLM_REASONING_EFFORT'],
    ['a throttle of zero', { LLM_REQUESTS_PER_MINUTE: '0' }, 'LLM_REQUESTS_PER_MINUTE'],
  ])('rejects %s', (_label, overrides, variable) => {
    expect(configError(compat(overrides)).variables).toEqual([variable]);
  });

  it('allows plain http only for a local server such as Ollama', () => {
    expect(loadLlmConfig(compat({ LLM_BASE_URL: 'http://localhost:11434/v1' }))).toMatchObject({ baseUrl: 'http://localhost:11434/v1' });
    expect(loadLlmConfig(compat({ LLM_BASE_URL: 'http://127.0.0.1:11434/v1/' }))).toMatchObject({ baseUrl: 'http://127.0.0.1:11434/v1' });
  });

  it('never shows the key when the config is serialized', () => {
    const config = loadLlmConfig(compat());
    expect(JSON.stringify(config)).not.toContain(KEY);
    expect(inspect(config, { depth: 10, showHidden: true })).not.toContain(KEY);
  });
});

describe('API key redaction', () => {
  it.each([
    ['JSON.stringify of the config', () => JSON.stringify(loadLlmConfig(env()))],
    ['String of the secret', () => String(loadLlmConfig(env()).apiKey)],
    ['a template literal', () => `${loadLlmConfig(env()).apiKey.toString()}`],
    ['util.inspect of the config', () => inspect(loadLlmConfig(env()), { depth: 10, showHidden: true })],
    ['an error-style dump', () => JSON.stringify({ context: { config: loadLlmConfig(env()) } })],
  ])('the key never appears in %s', (_label, render) => {
    const output = render();
    expect(output).not.toContain(KEY);
    expect(output).toContain('[REDACTED]');
  });

  it('exposes no enumerable property holding the key', () => {
    expect(Object.keys(new Secret(KEY))).toEqual([]);
  });
});
