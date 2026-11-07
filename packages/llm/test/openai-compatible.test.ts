import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createAdapter } from '../src/adapters/create.js';
import { trimTrailingSlashes } from '../src/adapters/http.js';
import { type FetchLike, OpenAICompatibleAdapter } from '../src/adapters/openai-compatible.js';
import { Secret, loadLlmConfig } from '../src/config.js';
import { ProviderError, type ProviderErrorCode } from '../src/errors.js';
import type { ProviderRequest } from '../src/provider.js';

const KEY = 'nvapi-test-PLACEHOLDER-not-a-real-key';
const BASE = 'https://integrate.api.nvidia.com/v1';
const MODEL = 'mistralai/mistral-large-4-1t-a52b';
const NOW = Date.parse('2026-11-08T12:00:00Z');
const request: ProviderRequest = { system: 'sys', userText: 'user', maxOutputTokens: 512, timeoutMs: 5_000 };
const SCHEMA = { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'integer' } } };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const completion = (overrides: Record<string, unknown> = {}) => ({
  id: 'chatcmpl-1',
  model: MODEL,
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"a":1}', reasoning_content: 'thinking...' } }],
  usage: { prompt_tokens: 40, completion_tokens: 12 },
  ...overrides,
});

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function harness(replies: (Response | Error | (() => Promise<Response>))[], opts: { reasoningEffort?: 'low'; requestsPerMinute?: number } = {}) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let now = NOW;
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body as string) as Record<string, unknown> });
    const reply = replies.shift();
    if (reply === undefined) throw new Error('unexpected call');
    if (typeof reply === 'function') return reply();
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  };
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: BASE,
    model: MODEL,
    apiKey: new Secret(KEY),
    fetch,
    clock: { now: () => now },
    sleep: (ms) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
    ...opts,
  });
  return { adapter, calls, sleeps, advance: (ms: number) => (now += ms) };
}

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ProviderError);
  return error as ProviderError;
}

describe('OpenAICompatibleAdapter: request', () => {
  it('posts chat completions with the key in the header only, and strict structured output', async () => {
    const { adapter, calls } = harness([json(200, completion())], { reasoningEffort: 'low' });
    await adapter.complete({ ...request, responseJsonSchema: SCHEMA });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/chat/completions`);
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers).toEqual({ Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });
    expect(calls[0]?.body).toEqual({
      model: MODEL,
      max_tokens: 512,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'user' },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'output', strict: true, schema: SCHEMA } },
      reasoning_effort: 'low',
    });
  });

  it('sends no tool, function or sampling fields, even if the request object carries extra keys', async () => {
    const { adapter, calls } = harness([json(200, completion())]);
    const sneaky = { ...request, tools: [{ type: 'function' }], tool_choice: 'required', functions: [], temperature: 2 } as ProviderRequest;
    await adapter.complete(sneaky);
    const body = calls[0]?.body ?? {};
    for (const field of ['tools', 'tool_choice', 'functions', 'function_call', 'parallel_tool_calls', 'temperature', 'response_format', 'reasoning_effort']) {
      expect(body).not.toHaveProperty(field);
    }
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model']);
  });

  it('accepts a base URL with a trailing slash', async () => {
    const replies = [json(200, completion())];
    const calls: string[] = [];
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: `${BASE}/`,
      model: MODEL,
      apiKey: new Secret(KEY),
      fetch: (url) => {
        calls.push(url);
        return Promise.resolve(replies.shift() ?? json(500, {}));
      },
    });
    await adapter.complete(request);
    expect(calls).toEqual([`${BASE}/chat/completions`]);
  });
});

describe('OpenAICompatibleAdapter: response', () => {
  it('returns the content, usage and the model that answered, ignoring reasoning text', async () => {
    const { adapter } = harness([json(200, completion())]);
    expect(await adapter.complete(request)).toEqual({ text: '{"a":1}', usage: { inputTokens: 40, outputTokens: 12 }, model: MODEL, stopReason: 'end' });
  });

  it.each([
    ['stop', 'end'],
    ['length', 'max_tokens'],
    ['content_filter', 'refusal'],
    ['tool_calls', 'other'],
    [null, 'other'],
  ])('maps finish_reason %s to %s', async (finish, stopReason) => {
    const body = completion({ choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content: '' } }] });
    const { adapter } = harness([json(200, body)]);
    expect((await adapter.complete(request)).stopReason).toBe(stopReason);
  });

  it('treats null content (e.g. all tokens spent on reasoning) as empty text', async () => {
    const body = completion({ choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: null } }] });
    const { adapter } = harness([json(200, body)]);
    expect(await adapter.complete(request)).toMatchObject({ text: '', stopReason: 'max_tokens' });
  });

  it.each([
    ['a gateway page', new Response('<html>busy</html>', { status: 200 })],
    ['a body without choices', json(200, { model: MODEL, usage: { prompt_tokens: 1, completion_tokens: 1 } })],
  ])('treats %s on HTTP 200 as the provider being unavailable', async (_label, response) => {
    const { adapter } = harness([response]);
    expect((await failure(adapter.complete(request))).code).toBe('PROVIDER_UNAVAILABLE');
  });
});

describe('OpenAICompatibleAdapter: errors', () => {
  it.each<[number, ProviderErrorCode]>([
    [400, 'PROVIDER_BAD_REQUEST'],
    [401, 'PROVIDER_AUTH'],
    [403, 'PROVIDER_AUTH'],
    [404, 'PROVIDER_BAD_REQUEST'],
    [408, 'PROVIDER_TIMEOUT'],
    [413, 'CONTEXT_TOO_LARGE'],
    [422, 'PROVIDER_BAD_REQUEST'],
    [500, 'PROVIDER_UNAVAILABLE'],
    [503, 'PROVIDER_UNAVAILABLE'],
  ])('maps HTTP %i to %s, keeping the status but never the body', async (status, code) => {
    const { adapter } = harness([json(status, { detail: `echo of the prompt: user ${KEY}` }, { 'x-request-id': 'req-9' })]);
    const error = await failure(adapter.complete(request));
    expect(error.code).toBe(code);
    expect(error.details).toEqual({ status, requestId: 'req-9' });
    expect(`${error.message} ${JSON.stringify(error)} ${inspect(error)}`).not.toMatch(/echo of the prompt|nvapi-/);
  });

  it('maps a 400 about the context length to CONTEXT_TOO_LARGE', async () => {
    const { adapter } = harness([json(400, { error: { message: "This model's maximum context length is 32768 tokens" } })]);
    expect((await failure(adapter.complete(request))).code).toBe('CONTEXT_TOO_LARGE');
  });

  it('maps 429 to a retryable rate-limit error carrying Retry-After, so the client backs off', async () => {
    const { adapter } = harness([json(429, { status: 429, title: 'Too Many Requests' }, { 'retry-after': '7' })]);
    const error = await failure(adapter.complete(request));
    expect(error).toMatchObject({ code: 'PROVIDER_RATE_LIMITED', retryable: true, details: { status: 429, retryAfterMs: 7_000 } });
  });

  it('maps its own timeout to PROVIDER_TIMEOUT and other network failures to PROVIDER_UNAVAILABLE', async () => {
    const timedOut = harness([new DOMException('The operation was aborted due to timeout', 'TimeoutError')]);
    expect((await failure(timedOut.adapter.complete(request))).code).toBe('PROVIDER_TIMEOUT');
    const reset = harness([new TypeError('fetch failed')]);
    expect((await failure(reset.adapter.complete(request))).code).toBe('PROVIDER_UNAVAILABLE');
  });

  it("maps the caller's abort to ABORTED", async () => {
    const controller = new AbortController();
    const { adapter } = harness([
      () => {
        controller.abort();
        return Promise.reject(new DOMException('aborted', 'AbortError'));
      },
    ]);
    expect((await failure(adapter.complete({ ...request, signal: controller.signal }))).code).toBe('ABORTED');
  });

  it('passes a signal that enforces the per-call timeout', async () => {
    const { adapter, calls } = harness([json(200, completion())]);
    await adapter.complete(request);
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('OpenAICompatibleAdapter: throttle', () => {
  it('spaces calls to stay under requests-per-minute', async () => {
    const { adapter, sleeps } = harness([json(200, completion()), json(200, completion()), json(200, completion())], { requestsPerMinute: 30 });
    await adapter.complete(request);
    await adapter.complete(request);
    await adapter.complete(request);
    expect(sleeps).toEqual([2_000, 2_000]);
  });

  it('does not wait when the previous call is long enough ago', async () => {
    const { adapter, sleeps, advance } = harness([json(200, completion()), json(200, completion())], { requestsPerMinute: 30 });
    await adapter.complete(request);
    advance(5_000);
    await adapter.complete(request);
    expect(sleeps).toEqual([]);
  });

  it('spaces concurrent calls too: each reserves the next slot before it waits', async () => {
    const started: number[] = [];
    let now = NOW;
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: BASE,
      model: MODEL,
      apiKey: new Secret(KEY),
      requestsPerMinute: 60,
      clock: { now: () => now },
      // Real-time-like: the clock only moves once every caller has reserved its slot.
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(() => resolve(), 0)).then(() => void (now = Math.max(now, NOW + ms))),
      fetch: () => {
        started.push(now - NOW);
        return Promise.resolve(json(200, completion()));
      },
    });
    await Promise.all([adapter.complete(request), adapter.complete(request), adapter.complete(request)]);
    expect(started.sort((a, b) => a - b)).toEqual([0, 1_000, 2_000]);
  });

  it('stops waiting with ABORTED when the caller aborts during the wait', async () => {
    const controller = new AbortController();
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: BASE,
      model: MODEL,
      apiKey: new Secret(KEY),
      requestsPerMinute: 1,
      fetch: () => Promise.resolve(json(200, completion())),
    });
    await adapter.complete(request);
    const waiting = adapter.complete({ ...request, signal: controller.signal });
    controller.abort();
    expect((await failure(waiting)).code).toBe('ABORTED');
  });
});

describe('createAdapter', () => {
  it('builds the adapter that LLM_PROVIDER names', () => {
    const compat = createAdapter(loadLlmConfig({ LLM_PROVIDER: 'openai-compatible', LLM_BASE_URL: BASE, LLM_MODEL: MODEL, LLM_API_KEY: KEY }));
    expect(compat).toBeInstanceOf(OpenAICompatibleAdapter);
    const anthropic = createAdapter(loadLlmConfig({ ANTHROPIC_API_KEY: KEY }));
    expect(anthropic).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5' });
  });
});

describe('OpenAICompatibleAdapter: configuration', () => {
  it('builds from config and never exposes the key when inspected or serialized', () => {
    const config = loadLlmConfig({ LLM_PROVIDER: 'openai-compatible', LLM_BASE_URL: BASE, LLM_MODEL: MODEL, LLM_API_KEY: KEY });
    if (config.provider !== 'openai-compatible') throw new Error('unreachable');
    const adapter = OpenAICompatibleAdapter.fromConfig(config);
    expect(adapter).toMatchObject({ provider: 'openai-compatible', model: MODEL });
    expect(`${JSON.stringify(adapter)} ${inspect(adapter, { depth: 10, showHidden: true })}`).not.toContain(KEY);
  });
});

describe('base URL trimming (CodeQL js/polynomial-redos)', () => {
  // A long run of slashes that is not at the end made /\/+$/ retry from every position: quadratic time.
  const hostile = `https://example.com/${'/'.repeat(100_000)}x`;

  it('trims trailing slashes in linear time in the adapter', () => {
    const started = performance.now();
    const adapter = new OpenAICompatibleAdapter({ baseUrl: hostile, model: MODEL, apiKey: new Secret(KEY) });
    expect(performance.now() - started).toBeLessThan(200);
    expect(adapter.model).toBe(MODEL);
  });

  it('trims trailing slashes in linear time in the config loader, and still drops them', () => {
    const started = performance.now();
    expect(() => loadLlmConfig({ LLM_PROVIDER: 'openai-compatible', LLM_BASE_URL: hostile, LLM_MODEL: MODEL, LLM_API_KEY: KEY })).not.toThrow();
    expect(performance.now() - started).toBeLessThan(200);
    const config = loadLlmConfig({ LLM_PROVIDER: 'openai-compatible', LLM_BASE_URL: `${BASE}///`, LLM_MODEL: MODEL, LLM_API_KEY: KEY });
    expect(config.provider === 'openai-compatible' && config.baseUrl).toBe(BASE);
  });
});

describe('trimTrailingSlashes', () => {
  it.each([
    ['https://a.test/v1', 'https://a.test/v1'],
    ['https://a.test/v1/', 'https://a.test/v1'],
    ['https://a.test/v1///', 'https://a.test/v1'],
    ['https://a.test//v1', 'https://a.test//v1'],
    ['///', ''],
    ['', ''],
  ])('%j -> %j', (input, expected) => {
    expect(trimTrailingSlashes(input)).toBe(expected);
  });
});
