import { quarantineText } from '@mandate/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { FakeProvider, type FakeStep } from '../src/adapters/fake.js';
import { LlmClient, type LlmClientOptions, type StructuredRequest } from '../src/client.js';
import { LlmError, type LlmErrorCode, SchemaNotSupportedError } from '../src/errors.js';
import type { LogFields, Logger } from '../src/logger.js';
import type { ProviderAdapter, ProviderRequest } from '../src/provider.js';

const Answer = z.strictObject({ answer: z.int().min(0).max(100) });
const OK = { answer: 42 };
const UNTRUSTED = quarantineText('Cheap cable. UNTRUSTED_CANARY').text;

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
const settle = <T>(promise: Promise<T>): Promise<Settled<T>> =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

function counterNonceSource() {
  let counter = 0;
  return (length: number) => new Uint8Array(length).fill(++counter);
}

function request(overrides: Partial<StructuredRequest<typeof Answer>> = {}): StructuredRequest<typeof Answer> {
  return {
    schemaName: 'answer',
    schema: Answer,
    system: 'SYSTEM_CANARY. Reply with JSON.',
    parts: [
      { kind: 'trusted', text: 'Pick a number.' },
      { kind: 'untrusted', label: 'product_title', text: UNTRUSTED },
    ],
    ...overrides,
  };
}

function setup(steps: FakeStep[], overrides: Partial<LlmClientOptions> = {}) {
  const adapter = new FakeProvider(steps);
  const logs: { level: string; message: string; fields: LogFields }[] = [];
  const record = (level: string) => (message: string, fields: LogFields) => logs.push({ level, message, fields });
  const logger: Logger = { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };
  const client = new LlmClient({
    adapter,
    logger,
    timeoutMs: 30_000,
    maxOutputTokens: 1_000,
    random: () => 0.5,
    nonceSource: counterNonceSource(),
    ...overrides,
  });
  return { adapter, client, logs };
}

function expectLlmError(result: Settled<unknown>, code: LlmErrorCode, attempts: number) {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(LlmError);
  expect(result.error).toMatchObject({ code, attempts });
}

const nonceOf = (sent: ProviderRequest | undefined) => /id="([0-9a-f]{32})"/.exec(sent?.userText ?? '')?.[1];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('LlmClient structured output', () => {
  it('returns validated data on the first try and sends a strict schema with no tool fields', async () => {
    const { adapter, client } = setup([FakeProvider.json(OK)]);
    const result = await client.generateStructured(request());

    expect(result).toMatchObject({ data: OK, attempts: 1, model: 'fake-model' });
    const sent = adapter.requests[0];
    expect(sent?.responseJsonSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(sent?.system).toContain('SYSTEM_CANARY');
    expect(sent?.system).toContain('<untrusted_data>');
    expect(sent?.userText).toMatch(
      /<untrusted_data id="[0-9a-f]{32}" label="product_title">\nCheap cable\. UNTRUSTED_CANARY\n<\/untrusted_data id="[0-9a-f]{32}">/,
    );
    expect(Object.keys(sent ?? {})).not.toEqual(expect.arrayContaining(['tools']));
    expect(Object.keys(sent ?? {})).not.toEqual(expect.arrayContaining(['tool_choice', 'functions', 'temperature']));
  });

  it('repairs once: invalid then valid, with a fresh nonce and no model output re-sent', async () => {
    const { adapter, client } = setup([FakeProvider.json({ answer: 'OUTPUT_CANARY' }), FakeProvider.json(OK)]);
    const result = await client.generateStructured(request());

    expect(result).toMatchObject({ data: OK, attempts: 2 });
    const repair = adapter.requests[1]?.userText ?? '';
    expect(repair).toContain('did not match the required JSON schema');
    expect(repair).toContain('answer: invalid_type');
    expect(repair).not.toContain('OUTPUT_CANARY');
    expect(repair.match(/UNTRUSTED_CANARY/g)).toHaveLength(1);
    expect(nonceOf(adapter.requests[1])).not.toBe(nonceOf(adapter.requests[0]));
  });

  it('fails with SCHEMA_INVALID when the repair is also invalid', async () => {
    const { client } = setup([FakeProvider.json({ answer: -1 }), FakeProvider.json({ answer: 101 })]);
    const result = await settle(client.generateStructured(request()));
    expectLlmError(result, 'SCHEMA_INVALID', 2);
    expect(result.ok || (result.error as LlmError).retryable).toBe(false);
  });

  it('treats malformed JSON as a schema failure eligible for repair', async () => {
    const recovered = setup([{ kind: 'reply', text: '{"answer": 4' }, FakeProvider.json(OK)]);
    await expect(recovered.client.generateStructured(request())).resolves.toMatchObject({ data: OK, attempts: 2 });
    expect(recovered.adapter.requests[1]?.userText).toContain('was not valid JSON');

    const failed = setup([{ kind: 'reply', text: '{' }, { kind: 'reply', text: 'not json' }]);
    expectLlmError(await settle(failed.client.generateStructured(request())), 'SCHEMA_INVALID', 2);
  });

  it('fails with EMPTY_OUTPUT when both replies are empty, and recovers from one empty reply', async () => {
    const empty = setup([{ kind: 'reply', text: '' }, { kind: 'reply', text: '  \n' }]);
    expectLlmError(await settle(empty.client.generateStructured(request())), 'EMPTY_OUTPUT', 2);

    const recovered = setup([{ kind: 'reply', text: '' }, FakeProvider.json(OK)]);
    await expect(recovered.client.generateStructured(request())).resolves.toMatchObject({ data: OK, attempts: 2 });
  });

  it('rejects a reply with extra fields, counting them without echoing model-chosen key names', async () => {
    const reply = { answer: 1, ignore_previous_instructions: true };
    const { adapter, client } = setup([FakeProvider.json(reply), FakeProvider.json(reply)]);
    expectLlmError(await settle(client.generateStructured(request())), 'SCHEMA_INVALID', 2);
    const repair = adapter.requests[1]?.userText ?? '';
    expect(repair).toContain('1 unexpected field');
    expect(repair).not.toContain('ignore_previous_instructions');
  });

  it('checks the stop reason before parsing: valid JSON cut off at max_tokens is never accepted', async () => {
    const { adapter, client } = setup([FakeProvider.json(OK, { stopReason: 'max_tokens' })], { maxOutputTokens: 16_000 });
    expectLlmError(await settle(client.generateStructured(request())), 'OUTPUT_TRUNCATED', 1);
    expect(adapter.requests).toHaveLength(1);
  });

  it('retries a max_tokens stop once with a doubled cap, then fails with OUTPUT_TRUNCATED', async () => {
    const recovered = setup([FakeProvider.json(OK, { stopReason: 'max_tokens' }), FakeProvider.json(OK)]);
    await expect(recovered.client.generateStructured(request())).resolves.toMatchObject({ data: OK, attempts: 2 });
    expect(recovered.adapter.requests.map((r) => r.maxOutputTokens)).toEqual([1_000, 2_000]);

    const truncated = setup([
      FakeProvider.json(OK, { stopReason: 'max_tokens' }),
      FakeProvider.json(OK, { stopReason: 'max_tokens' }),
    ]);
    expectLlmError(await settle(truncated.client.generateStructured(request())), 'OUTPUT_TRUNCATED', 2);
  });

  it('caps the escalated output budget at the ceiling', async () => {
    const { adapter, client } = setup([FakeProvider.json(OK, { stopReason: 'max_tokens' }), FakeProvider.json(OK)], {
      maxOutputTokens: 12_000,
    });
    await client.generateStructured(request());
    expect(adapter.requests[1]?.maxOutputTokens).toBe(16_000);
  });

  it.each([
    ['refusal', 'REFUSAL'],
    ['context_window_exceeded', 'CONTEXT_TOO_LARGE'],
  ] as const)('maps a %s stop to %s without retrying, even when the text parses', async (stopReason, code) => {
    const { adapter, client } = setup([FakeProvider.json(OK, { stopReason }), FakeProvider.json(OK)]);
    expectLlmError(await settle(client.generateStructured(request())), code, 1);
    expect(adapter.requests).toHaveLength(1);
  });

  it('sums usage across every attempt', async () => {
    const { client } = setup([
      FakeProvider.json({ answer: 'x' }, { usage: { inputTokens: 10, outputTokens: 5 } }),
      FakeProvider.json(OK, { usage: { inputTokens: 20, outputTokens: 7 } }),
    ]);
    const result = await client.generateStructured(request());
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 12 });
  });
});

describe('LlmClient transport retries', () => {
  it('retries a 5xx with full-jitter backoff (base 250 ms)', async () => {
    const { adapter, client } = setup([{ kind: 'error', code: 'PROVIDER_UNAVAILABLE' }, FakeProvider.json(OK)]);
    const pending = settle(client.generateStructured(request()));

    await vi.advanceTimersByTimeAsync(124);
    expect(adapter.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(adapter.requests).toHaveLength(2);
    expect(await pending).toMatchObject({ ok: true, value: { data: OK, attempts: 2 } });
  });

  it('honours Retry-After on a 429 instead of the jittered delay', async () => {
    const { adapter, client } = setup([
      { kind: 'error', code: 'PROVIDER_RATE_LIMITED', retryAfterMs: 2_000 },
      FakeProvider.json(OK),
    ]);
    const pending = settle(client.generateStructured(request()));

    await vi.advanceTimersByTimeAsync(1_999);
    expect(adapter.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ ok: true, value: { attempts: 2 } });
  });

  it('fails fast when Retry-After is past the deadline', async () => {
    const { adapter, client } = setup(
      [{ kind: 'error', code: 'PROVIDER_RATE_LIMITED', retryAfterMs: 60_000 }, FakeProvider.json(OK)],
      { timeoutMs: 5_000 },
    );
    const pending = settle(client.generateStructured(request()));
    await vi.advanceTimersByTimeAsync(0);
    expectLlmError(await pending, 'PROVIDER_RATE_LIMITED', 1);
    expect(adapter.requests).toHaveLength(1);
  });

  it('makes at most 3 transport calls for one prompt', async () => {
    const steps: FakeStep[] = Array.from({ length: 5 }, () => ({ kind: 'error', code: 'PROVIDER_UNAVAILABLE' }));
    const { adapter, client } = setup(steps);
    const pending = settle(client.generateStructured(request()));
    await vi.advanceTimersByTimeAsync(10_000);

    const result = await pending;
    expectLlmError(result, 'PROVIDER_UNAVAILABLE', 3);
    expect(result.ok || (result.error as LlmError).retryable).toBe(true);
    expect(adapter.requests).toHaveLength(3);
  });

  it('makes at most 4 calls in total, even when the repair prompt still has transport retries left', async () => {
    const { adapter, client } = setup([
      { kind: 'error', code: 'PROVIDER_UNAVAILABLE' },
      { kind: 'error', code: 'PROVIDER_UNAVAILABLE' },
      FakeProvider.json({ answer: 'invalid' }),
      { kind: 'error', code: 'PROVIDER_UNAVAILABLE' },
      FakeProvider.json(OK),
    ]);
    const pending = settle(client.generateStructured(request()));
    await vi.advanceTimersByTimeAsync(10_000);

    expectLlmError(await pending, 'PROVIDER_UNAVAILABLE', 4);
    expect(adapter.requests).toHaveLength(4);
    expect(adapter.remainingSteps).toBe(1);
  });

  it('does not retry a non-retryable provider error', async () => {
    const { adapter, client } = setup([{ kind: 'error', code: 'PROVIDER_AUTH' }, FakeProvider.json(OK)]);
    const result = await settle(client.generateStructured(request()));
    expectLlmError(result, 'PROVIDER_AUTH', 1);
    expect(result.ok || (result.error as LlmError).retryable).toBe(false);
    expect(adapter.requests).toHaveLength(1);
  });

  it('propagates an unexpected adapter bug unchanged and does not retry it', async () => {
    const bug = new TypeError('adapter bug');
    const complete = vi.fn<ProviderAdapter['complete']>().mockRejectedValue(bug);
    const client = new LlmClient({ adapter: { provider: 'buggy', model: 'm', complete }, timeoutMs: 5_000, maxOutputTokens: 100 });
    await expect(client.generateStructured(request())).rejects.toBe(bug);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe('LlmClient deadline and abort', () => {
  it('respects the overall deadline across attempts', async () => {
    const { adapter, client } = setup(
      [
        { kind: 'error', code: 'PROVIDER_UNAVAILABLE', delayMs: 4_000 },
        { kind: 'reply', text: JSON.stringify(OK), delayMs: 4_000 },
      ],
      { timeoutMs: 5_000 },
    );
    const pending = settle(client.generateStructured(request()));

    await vi.advanceTimersByTimeAsync(4_999);
    expect(adapter.requests[1]?.timeoutMs).toBe(875);
    await vi.advanceTimersByTimeAsync(1);
    expectLlmError(await pending, 'PROVIDER_TIMEOUT', 2);
  });

  it('enforces the deadline even against an adapter that ignores timeoutMs and the signal', async () => {
    const adapter: ProviderAdapter = { provider: 'hung', model: 'm', complete: () => new Promise(() => undefined) };
    const client = new LlmClient({ adapter, timeoutMs: 3_000, maxOutputTokens: 100 });
    const pending = settle(client.generateStructured(request()));

    await vi.advanceTimersByTimeAsync(3_000);
    expectLlmError(await pending, 'PROVIDER_TIMEOUT', 1);
  });

  it('aborts mid-flight promptly', async () => {
    const { client } = setup([{ kind: 'reply', text: JSON.stringify(OK), delayMs: 10_000 }]);
    const controller = new AbortController();
    const pending = settle(client.generateStructured(request({ signal: controller.signal })));

    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expectLlmError(await pending, 'ABORTED', 1);
  });

  it('aborts promptly even when the adapter ignores the signal', async () => {
    const adapter: ProviderAdapter = { provider: 'hung', model: 'm', complete: () => new Promise(() => undefined) };
    const client = new LlmClient({ adapter, timeoutMs: 60_000, maxOutputTokens: 100 });
    const controller = new AbortController();
    const pending = settle(client.generateStructured(request({ signal: controller.signal })));

    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expectLlmError(await pending, 'ABORTED', 1);
  });

  it('aborts during a backoff sleep without another call', async () => {
    const { adapter, client } = setup([{ kind: 'error', code: 'PROVIDER_UNAVAILABLE' }, FakeProvider.json(OK)]);
    const controller = new AbortController();
    const pending = settle(client.generateStructured(request({ signal: controller.signal })));

    await vi.advanceTimersByTimeAsync(50);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expectLlmError(await pending, 'ABORTED', 1);
    expect(adapter.requests).toHaveLength(1);
  });

  it('makes no call when the signal is already aborted', async () => {
    const { adapter, client } = setup([FakeProvider.json(OK)]);
    expectLlmError(await settle(client.generateStructured(request({ signal: AbortSignal.abort() }))), 'ABORTED', 0);
    expect(adapter.requests).toHaveLength(0);
  });
});

describe('LlmClient schema guard', () => {
  it.each([
    ['a schema with a transform', z.strictObject({ s: z.string().transform((s) => s.length) })],
    ['a non-strict object', z.object({ answer: z.int() })],
    ['a nested non-strict object', z.strictObject({ inner: z.object({ a: z.int() }) })],
  ])('rejects %s before any provider call', async (_label, schema) => {
    const { adapter, client } = setup([FakeProvider.json(OK)]);
    await expect(client.generateStructured({ ...request(), schema })).rejects.toBeInstanceOf(SchemaNotSupportedError);
    expect(adapter.requests).toHaveLength(0);
  });
});

describe('LlmClient logging', () => {
  it('logs metadata and a prompt hash, never prompt text, model output or canaries', async () => {
    const { client, logs } = setup([FakeProvider.json({ answer: 'OUTPUT_CANARY' }), FakeProvider.json(OK)]);
    await client.generateStructured(request());

    const serialized = JSON.stringify(logs);
    for (const canary of ['SYSTEM_CANARY', 'UNTRUSTED_CANARY', 'OUTPUT_CANARY', 'Pick a number']) {
      expect(serialized).not.toContain(canary);
    }
    const result = logs.find((entry) => entry.message === 'llm.result');
    expect(result?.fields).toMatchObject({
      provider: 'fake',
      model: 'fake-model',
      schema: 'answer',
      attempts: 2,
      outcome: 'OK',
      inputTokens: 20,
      outputTokens: 10,
    });
    expect(result?.fields['promptSha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof result?.fields['latencyMs']).toBe('number');
  });

  it('logs the failure code and keeps canaries out of the error message', async () => {
    const { client, logs } = setup([FakeProvider.json({ answer: 'OUTPUT_CANARY' }), FakeProvider.json({ answer: -5 })]);
    const result = await settle(client.generateStructured(request()));

    expect(logs.find((entry) => entry.message === 'llm.result')?.fields).toMatchObject({ outcome: 'SCHEMA_INVALID' });
    const message = result.ok ? '' : (result.error as Error).message;
    expect(message).not.toMatch(/CANARY|Pick a number/);
  });
});
