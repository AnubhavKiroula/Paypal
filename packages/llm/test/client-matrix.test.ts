import { quarantineText } from '@mandate/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DEFAULT_FAKE_USAGE, FakeProvider, type FakeStep } from '../src/adapters/fake.js';
import { LlmClient, type LlmClientOptions, type StructuredRequest } from '../src/client.js';
import {
  LlmError,
  type LlmErrorCode,
  ProviderError,
  type ProviderErrorCode,
  SchemaNotSupportedError,
  isRetryable,
} from '../src/errors.js';
import type { LogFields, Logger } from '../src/logger.js';
import { type NonceSource, type PromptPart, UNTRUSTED_DATA_NOTICE } from '../src/prompt.js';
import type { ProviderAdapter, ProviderRequest, ProviderResponse } from '../src/provider.js';
import { AbortedError, type Clock, type Sleep, defaultSleep, systemClock } from '../src/time.js';

// Boundary and combination cases for the client's retry, budget and deadline arithmetic, plus the
// time, fake-provider and error primitives it is built on. Complements client.test.ts.

const Answer = z.strictObject({ answer: z.int().min(0).max(100) });
const OK = { answer: 42 };
const INVALID = { answer: 'not a number' };
const SYSTEM = 'SYSTEM_CANARY. Reply with JSON.';
const TRUSTED: PromptPart = { kind: 'trusted', text: 'Pick a number.' };
const UNTRUSTED: PromptPart = { kind: 'untrusted', label: 'product_title', text: quarantineText('Cheap cable.').text };
const UNAVAILABLE: FakeStep = { kind: 'error', code: 'PROVIDER_UNAVAILABLE' };
const REPAIR_SUFFIX = 'Reply again with only a JSON object that matches the schema.';
const truncatedReply = (): FakeStep => FakeProvider.json(OK, { stopReason: 'max_tokens' });

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
const settle = <T>(promise: Promise<T>): Promise<Settled<T>> =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

function counterNonceSource(): NonceSource {
  let counter = 0;
  return (length) => new Uint8Array(length).fill(++counter);
}

function request(overrides: Partial<StructuredRequest<typeof Answer>> = {}): StructuredRequest<typeof Answer> {
  return { schemaName: 'answer', schema: Answer, system: SYSTEM, parts: [TRUSTED, UNTRUSTED], ...overrides };
}

type LogEntry = { level: keyof Logger; message: string; fields: LogFields };

function captureLogs() {
  const logs: LogEntry[] = [];
  const record = (level: keyof Logger) => (message: string, fields: LogFields) => {
    logs.push({ level, message, fields });
  };
  const logger: Logger = { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };
  return { logs, logger };
}

const resultLogs = (logs: readonly LogEntry[]) => logs.filter((entry) => entry.message === 'llm.result');
const attemptLogs = (logs: readonly LogEntry[]) => logs.filter((entry) => entry.message === 'llm.attempt');

/** Records every delay the client asks for (backoff and per-call deadline timers), then really sleeps. */
function recordingSleep() {
  const delays: number[] = [];
  const sleep: Sleep = (ms, signal) => {
    delays.push(ms);
    return defaultSleep(ms, signal);
  };
  return { delays, sleep };
}

function setup(steps: readonly FakeStep[], overrides: Partial<LlmClientOptions> = {}) {
  const adapter = new FakeProvider(steps);
  const { logs, logger } = captureLogs();
  const { delays, sleep } = recordingSleep();
  const client = new LlmClient({
    adapter,
    logger,
    sleep,
    timeoutMs: 30_000,
    maxOutputTokens: 1_000,
    random: () => 0.5,
    nonceSource: counterNonceSource(),
    ...overrides,
  });
  return { adapter, client, logs, delays };
}

/** A hand-written adapter for cases FakeProvider cannot script (error details, clock movement, hangs). */
function stubClient(impl: ProviderAdapter['complete'], overrides: Partial<LlmClientOptions> = {}) {
  const complete = vi.fn<ProviderAdapter['complete']>(impl);
  const adapter: ProviderAdapter = { provider: 'stub', model: 'stub-model', complete };
  const { logs, logger } = captureLogs();
  const client = new LlmClient({ adapter, logger, timeoutMs: 30_000, maxOutputTokens: 1_000, random: () => 0, ...overrides });
  return { client, complete, logs };
}

const reply = (text: string): ProviderResponse => ({
  text,
  usage: { inputTokens: 3, outputTokens: 2 },
  model: 'stub-model',
  stopReason: 'end',
});

function expectLlmError(result: Settled<unknown>, code: LlmErrorCode, attempts: number): LlmError {
  if (result.ok || !(result.error instanceof LlmError)) throw new Error(`expected an LlmError with code ${code}`);
  expect(result.error).toMatchObject({ code, attempts });
  return result.error;
}

const providerRequest = (overrides: Partial<ProviderRequest> = {}): ProviderRequest => ({
  system: 's',
  userText: 'u',
  maxOutputTokens: 10,
  timeoutMs: 100,
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('defaultSleep and systemClock', () => {
  it('resolves after exactly ms and not a tick earlier', async () => {
    const done = vi.fn();
    void defaultSleep(1_000).then(done);
    await vi.advanceTimersByTimeAsync(999);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalledOnce();
  });

  it('rejects at once with AbortedError for an already-aborted signal and schedules no timer', async () => {
    const sleeping = defaultSleep(1_000, AbortSignal.abort());
    expect(vi.getTimerCount()).toBe(0);
    await expect(sleeping).rejects.toThrow(AbortedError);
    await expect(sleeping).rejects.toMatchObject({ name: 'AbortedError', message: 'Aborted' });
  });

  it('rejects with AbortedError when aborted mid-sleep and cancels its timer', async () => {
    const controller = new AbortController();
    const sleeping = settle(defaultSleep(1_000, controller.signal));
    await vi.advanceTimersByTimeAsync(400);
    expect(vi.getTimerCount()).toBe(1);

    controller.abort();
    expect(vi.getTimerCount()).toBe(0);
    const result = await sleeping;
    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error).toBeInstanceOf(AbortedError);
  });

  it('detaches its abort listener once it resolves', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const sleeping = defaultSleep(10, controller.signal);
    expect(remove).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10);
    await expect(sleeping).resolves.toBeUndefined();
    expect(add).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(remove.mock.calls[0]?.[0]).toBe('abort');
    expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
  });

  it('systemClock reads the wall clock', () => {
    vi.setSystemTime(new Date('2026-01-02T03:04:05.678Z'));
    expect(systemClock.now()).toBe(Date.UTC(2026, 0, 2, 3, 4, 5, 678));
  });
});

describe('FakeProvider', () => {
  it('records every request in order, including one that finds the script empty, then throws a plain Error', async () => {
    const fake = new FakeProvider([FakeProvider.json(OK)]);
    const first = providerRequest({ userText: 'first' });
    const second = providerRequest({ userText: 'second' });

    await expect(fake.complete(first)).resolves.toMatchObject({ text: JSON.stringify(OK) });
    expect(fake.remainingSteps).toBe(0);
    const exhausted = await settle(fake.complete(second));

    expect(exhausted.ok).toBe(false);
    const error = exhausted.ok ? undefined : exhausted.error;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ message: 'FakeProvider: no scripted step left' });
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0]).toBe(first);
    expect(fake.requests[1]).toBe(second);
  });

  it('applies defaults (model, usage, stop reason) and lets each step override them, without sleeping', async () => {
    const sleep = vi.fn<Sleep>().mockResolvedValue(undefined);
    const usage = { inputTokens: 7, outputTokens: 9 };
    const fake = new FakeProvider(
      [FakeProvider.json(OK), FakeProvider.json(OK, { usage, model: 'served-model', stopReason: 'refusal' })],
      { model: 'custom-model', sleep },
    );

    expect(fake.provider).toBe('fake');
    expect(fake.model).toBe('custom-model');
    await expect(fake.complete(providerRequest())).resolves.toEqual({
      text: '{"answer":42}',
      usage: DEFAULT_FAKE_USAGE,
      model: 'custom-model',
      stopReason: 'end',
    });
    await expect(fake.complete(providerRequest())).resolves.toEqual({
      text: '{"answer":42}',
      usage,
      model: 'served-model',
      stopReason: 'refusal',
    });
    expect(new FakeProvider([]).model).toBe('fake-model');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('copies the script, so later changes to the caller array have no effect', () => {
    const steps: FakeStep[] = [FakeProvider.json(OK)];
    const fake = new FakeProvider(steps);
    steps.push(FakeProvider.json(OK), FakeProvider.json(OK));
    expect(fake.remainingSteps).toBe(1);
  });

  it('throws scripted errors as ProviderError, with retryAfterMs only when it was scripted', async () => {
    const fake = new FakeProvider([
      { kind: 'error', code: 'PROVIDER_RATE_LIMITED', retryAfterMs: 1_500 },
      { kind: 'error', code: 'PROVIDER_AUTH' },
    ]);

    const limited = await settle(fake.complete(providerRequest()));
    expect(limited.ok ? undefined : limited.error).toBeInstanceOf(ProviderError);
    expect(limited).toMatchObject({
      ok: false,
      error: { code: 'PROVIDER_RATE_LIMITED', retryable: true, details: { retryAfterMs: 1_500 } },
    });

    const auth = await settle(fake.complete(providerRequest()));
    expect(auth).toMatchObject({ ok: false, error: { code: 'PROVIDER_AUTH', retryable: false } });
    expect(auth.ok ? undefined : (auth.error as ProviderError).details).toEqual({});
  });

  it('waits min(delayMs, timeoutMs) on the injected sleep and times out only when delayMs exceeds timeoutMs', async () => {
    const sleep = vi.fn<Sleep>().mockResolvedValue(undefined);
    const fake = new FakeProvider(
      [
        { kind: 'reply', text: '{}', delayMs: 500 },
        { kind: 'reply', text: '{}', delayMs: 100 },
        { kind: 'error', code: 'PROVIDER_UNAVAILABLE', delayMs: 40 },
      ],
      { sleep },
    );
    const signal = new AbortController().signal;

    await expect(fake.complete(providerRequest({ signal }))).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    await expect(fake.complete(providerRequest({ signal }))).resolves.toMatchObject({ text: '{}' });
    await expect(fake.complete(providerRequest({ signal }))).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(sleep.mock.calls).toEqual([
      [100, signal],
      [100, signal],
      [40, signal],
    ]);
  });

  it('maps an AbortedError from the sleep to ProviderError ABORTED and rethrows any other sleep failure unchanged', async () => {
    const bug = new RangeError('sleep bug');
    const sleep = vi.fn<Sleep>().mockRejectedValueOnce(new AbortedError()).mockRejectedValueOnce(bug);
    const fake = new FakeProvider(
      [
        { kind: 'reply', text: '{}', delayMs: 10 },
        { kind: 'reply', text: '{}', delayMs: 10 },
      ],
      { sleep },
    );

    const aborted = await settle(fake.complete(providerRequest()));
    expect(aborted.ok ? undefined : aborted.error).toBeInstanceOf(ProviderError);
    expect(aborted).toMatchObject({ ok: false, error: { code: 'ABORTED', retryable: false } });
    await expect(fake.complete(providerRequest())).rejects.toBe(bug);
  });
});

describe('errors', () => {
  const RETRYABLE_BY_CODE: Record<LlmErrorCode, boolean> = {
    PROVIDER_TIMEOUT: true,
    PROVIDER_RATE_LIMITED: true,
    PROVIDER_UNAVAILABLE: true,
    PROVIDER_AUTH: false,
    PROVIDER_BAD_REQUEST: false,
    CONTEXT_TOO_LARGE: false,
    ABORTED: false,
    SCHEMA_INVALID: false,
    EMPTY_OUTPUT: false,
    REFUSAL: false,
    OUTPUT_TRUNCATED: false,
  };
  const ALL_CODES = Object.keys(RETRYABLE_BY_CODE) as LlmErrorCode[];
  const PROVIDER_CODES: ProviderErrorCode[] = [
    'PROVIDER_TIMEOUT',
    'PROVIDER_RATE_LIMITED',
    'PROVIDER_UNAVAILABLE',
    'PROVIDER_AUTH',
    'PROVIDER_BAD_REQUEST',
    'CONTEXT_TOO_LARGE',
    'ABORTED',
  ];

  it.each(ALL_CODES)('isRetryable(%s) matches the table, and LlmError.retryable agrees', (code) => {
    expect(isRetryable(code)).toBe(RETRYABLE_BY_CODE[code]);
    expect(new LlmError(code, 0).retryable).toBe(RETRYABLE_BY_CODE[code]);
  });

  it('gives every code its own fixed message, shared by ProviderError and LlmError, never echoing details', () => {
    const messages = ALL_CODES.map((code) => new LlmError(code, 1).message);
    expect(new Set(messages).size).toBe(ALL_CODES.length);
    for (const code of PROVIDER_CODES) {
      const providerError = new ProviderError(code, { status: 418, requestId: 'req_SECRET_ID', retryAfterMs: 777 });
      expect(providerError).toMatchObject({ name: 'ProviderError', code, retryable: RETRYABLE_BY_CODE[code] });
      expect(providerError.message).toBe(new LlmError(code, 1).message);
      expect(providerError.message).not.toMatch(/SECRET|418|777/);
    }
  });

  it('LlmError copies status and requestId from details, and leaves both undefined without details', () => {
    const detailed = new LlmError('PROVIDER_UNAVAILABLE', 3, { status: 503, requestId: 'req_9', retryAfterMs: 50 });
    expect(detailed).toMatchObject({ name: 'LlmError', code: 'PROVIDER_UNAVAILABLE', attempts: 3, status: 503, requestId: 'req_9' });
    expect(detailed).toBeInstanceOf(Error);

    const bare = new LlmError('REFUSAL', 1);
    expect(bare.status).toBeUndefined();
    expect(bare.requestId).toBeUndefined();
    expect(new ProviderError('ABORTED').details).toEqual({});
  });

  it('SchemaNotSupportedError names the schema and the reason', () => {
    const error = new SchemaNotSupportedError('purchase_intent', 'the root must be an object');
    expect(error.name).toBe('SchemaNotSupportedError');
    expect(error.message).toBe('Schema "purchase_intent" is not usable for structured output: the root must be an object');
  });
});

describe('LlmClient error details', () => {
  it('copies status and requestId from a non-retryable provider error, without retrying', async () => {
    const { client, complete } = stubClient(() =>
      Promise.reject(new ProviderError('PROVIDER_BAD_REQUEST', { status: 400, requestId: 'req_bad' })),
    );
    const error = expectLlmError(await settle(client.generateStructured(request())), 'PROVIDER_BAD_REQUEST', 1);
    expect(error).toMatchObject({ status: 400, requestId: 'req_bad', retryable: false });
    expect(complete).toHaveBeenCalledOnce();
  });

  it('reports the details of the last transport failure when retries run out', async () => {
    let call = 0;
    const { client, complete } = stubClient(() => {
      call++;
      return Promise.reject(new ProviderError('PROVIDER_UNAVAILABLE', { status: 500 + call, requestId: `req_${call}` }));
    });
    const pending = settle(client.generateStructured(request()));
    await vi.advanceTimersByTimeAsync(10_000);

    const error = expectLlmError(await pending, 'PROVIDER_UNAVAILABLE', 3);
    expect(error).toMatchObject({ status: 503, requestId: 'req_3', retryable: true });
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it('keeps the details when a Retry-After past the deadline forces a fast failure', async () => {
    const { client } = stubClient(
      () => Promise.reject(new ProviderError('PROVIDER_RATE_LIMITED', { retryAfterMs: 60_000, status: 429, requestId: 'req_rl' })),
      { timeoutMs: 5_000 },
    );
    const error = expectLlmError(await settle(client.generateStructured(request())), 'PROVIDER_RATE_LIMITED', 1);
    expect(error).toMatchObject({ status: 429, requestId: 'req_rl' });
  });

  it('maps an ABORTED raised by the adapter itself to LlmError ABORTED with its details, never retrying', async () => {
    const { client, complete } = stubClient(() =>
      Promise.reject(new ProviderError('ABORTED', { status: 499, requestId: 'req_ab' })),
    );
    const error = expectLlmError(await settle(client.generateStructured(request())), 'ABORTED', 1);
    expect(error).toMatchObject({ status: 499, requestId: 'req_ab' });
    expect(complete).toHaveBeenCalledOnce();
  });

  it('aborts the signal handed to a hung adapter when the deadline fires, with no provider details on the error', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const { client } = stubClient(
      (sent) => {
        signals.push(sent.signal);
        return new Promise(() => undefined);
      },
      { timeoutMs: 3_000 },
    );
    const pending = settle(client.generateStructured(request()));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const error = expectLlmError(await pending, 'PROVIDER_TIMEOUT', 1);
    expect(signals[0]?.aborted).toBe(true);
    expect(error.status).toBeUndefined();
    expect(error.requestId).toBeUndefined();
  });

  it("aborts the adapter's signal when the caller aborts mid-call", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const { client } = stubClient((sent) => {
      signals.push(sent.signal);
      return new Promise(() => undefined);
    });
    const controller = new AbortController();
    const pending = settle(client.generateStructured(request({ signal: controller.signal })));
    await vi.advanceTimersByTimeAsync(10);
    expect(signals[0]?.aborted).toBe(false);

    controller.abort();
    expectLlmError(await pending, 'ABORTED', 1);
    expect(signals[0]?.aborted).toBe(true);
  });
});

describe('LlmClient backoff and Retry-After', () => {
  it('retries immediately when random() returns 0', async () => {
    const { adapter, client, delays } = setup([UNAVAILABLE, FakeProvider.json(OK)], { random: () => 0 });
    const pending = settle(client.generateStructured(request()));
    await vi.advanceTimersByTimeAsync(0);

    expect(adapter.requests).toHaveLength(2);
    expect(await pending).toMatchObject({ ok: true, value: { data: OK, attempts: 2 } });
    expect(delays).toEqual([30_000, 0, 30_000]);
  });

  it('waits just under each attempt cap when random() returns 0.999 (249 ms, then 499 ms)', async () => {
    const { adapter, client, delays } = setup([UNAVAILABLE, UNAVAILABLE, UNAVAILABLE], { random: () => 0.999 });
    const pending = settle(client.generateStructured(request()));

    await vi.advanceTimersByTimeAsync(248);
    expect(adapter.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(adapter.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(498);
    expect(adapter.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(adapter.requests).toHaveLength(3);

    expectLlmError(await pending, 'PROVIDER_UNAVAILABLE', 3);
    expect(delays).toEqual([30_000, 249, 29_751, 499, 29_252]);
    expect(adapter.requests.map((sent) => sent.timeoutMs)).toEqual([30_000, 29_751, 29_252]);
  });

  it('uses a Retry-After of 0 as given instead of the jittered delay', async () => {
    const { client, delays } = setup(
      [{ kind: 'error', code: 'PROVIDER_RATE_LIMITED', retryAfterMs: 0 }, FakeProvider.json(OK)],
      { random: () => 0.999 },
    );
    const pending = settle(client.generateStructured(request()));
    await vi.advanceTimersByTimeAsync(0);

    expect(await pending).toMatchObject({ ok: true, value: { attempts: 2 } });
    expect(delays).toEqual([30_000, 0, 30_000]);
  });

  it('fails fast when Retry-After lands exactly on the deadline', async () => {
    const { adapter, client, delays } = setup(
      [{ kind: 'error', code: 'PROVIDER_RATE_LIMITED', retryAfterMs: 5_000 }, FakeProvider.json(OK)],
      { timeoutMs: 5_000 },
    );
    const pending = settle(client.generateStructured(request()));
    await vi.advanceTimersByTimeAsync(0);

    expectLlmError(await pending, 'PROVIDER_RATE_LIMITED', 1);
    expect(adapter.requests).toHaveLength(1);
    expect(delays).toEqual([5_000]);
  });

  it('retries when Retry-After ends 1 ms before the deadline, handing the adapter the last millisecond', async () => {
    const { adapter, client, delays } = setup(
      [{ kind: 'error', code: 'PROVIDER_RATE_LIMITED', retryAfterMs: 4_999 }, FakeProvider.json(OK)],
      { timeoutMs: 5_000 },
    );
    const pending = settle(client.generateStructured(request()));
    await vi.advanceTimersByTimeAsync(4_999);

    expect(await pending).toMatchObject({ ok: true, value: { data: OK, attempts: 2 } });
    expect(adapter.requests[1]?.timeoutMs).toBe(1);
    expect(delays).toEqual([5_000, 4_999, 1]);
  });

  it('measures the deadline from request.timeoutMs when it overrides the client default', async () => {
    const { adapter, client } = setup(
      [{ kind: 'error', code: 'PROVIDER_RATE_LIMITED', retryAfterMs: 1_234 }, FakeProvider.json(OK)],
      { timeoutMs: 60_000 },
    );
    const pending = settle(client.generateStructured(request({ timeoutMs: 1_234 })));
    await vi.advanceTimersByTimeAsync(0);

    expectLlmError(await pending, 'PROVIDER_RATE_LIMITED', 1);
    expect(adapter.requests[0]?.timeoutMs).toBe(1_234);
  });

  it('restarts the backoff schedule for each prompt: the repair prompt first retry uses the base delay', async () => {
    const { client, delays } = setup([UNAVAILABLE, FakeProvider.json(INVALID), UNAVAILABLE, FakeProvider.json(OK)]);
    const pending = settle(client.generateStructured(request()));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await pending).toMatchObject({ ok: true, value: { data: OK, attempts: 4 } });
    expect(delays).toEqual([30_000, 125, 29_875, 29_875, 125, 29_750]);
  });
});

describe('LlmClient escalation, repair and the 4-call budget', () => {
  it('escalates on max_tokens, then repairs a schema failure at the escalated budget', async () => {
    const { adapter, client, logs } = setup([truncatedReply(), FakeProvider.json(INVALID), FakeProvider.json(OK)]);
    const result = await client.generateStructured(request());

    expect(result).toMatchObject({ data: OK, attempts: 3 });
    expect(adapter.requests.map((sent) => sent.maxOutputTokens)).toEqual([1_000, 2_000, 2_000]);
    expect(adapter.requests[1]?.userText).not.toContain(REPAIR_SUFFIX);
    expect(adapter.requests[2]?.userText.endsWith(REPAIR_SUFFIX)).toBe(true);
    expect(attemptLogs(logs).map((entry) => entry.fields['phase'])).toEqual(['initial', 'escalation', 'repair']);
  });

  it('repairs first, then escalates while keeping the repair note', async () => {
    const { adapter, client, logs } = setup([FakeProvider.json(INVALID), truncatedReply(), FakeProvider.json(OK)]);
    const result = await client.generateStructured(request());

    expect(result).toMatchObject({ data: OK, attempts: 3 });
    expect(adapter.requests.map((sent) => sent.maxOutputTokens)).toEqual([1_000, 1_000, 2_000]);
    expect(adapter.requests[1]?.userText.endsWith(REPAIR_SUFFIX)).toBe(true);
    expect(adapter.requests[2]?.userText.endsWith(REPAIR_SUFFIX)).toBe(true);
    expect(attemptLogs(logs).map((entry) => entry.fields['phase'])).toEqual(['initial', 'repair', 'escalation']);
  });

  it('fits escalation, repair and a transport retry into exactly 4 calls', async () => {
    const { adapter, client, logs } = setup([truncatedReply(), FakeProvider.json(INVALID), UNAVAILABLE, FakeProvider.json(OK)]);
    const pending = settle(client.generateStructured(request()));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await pending).toMatchObject({ ok: true, value: { data: OK, attempts: 4 } });
    expect(adapter.requests.map((sent) => sent.maxOutputTokens)).toEqual([1_000, 2_000, 2_000, 2_000]);
    expect(attemptLogs(logs).map((entry) => entry.fields['phase'])).toEqual(['initial', 'escalation', 'repair', 'repair']);
  });

  it('does not escalate a max_tokens stop on the 4th call: OUTPUT_TRUNCATED', async () => {
    const { adapter, client } = setup([FakeProvider.json(INVALID), UNAVAILABLE, UNAVAILABLE, truncatedReply(), FakeProvider.json(OK)]);
    const pending = settle(client.generateStructured(request()));
    await vi.advanceTimersByTimeAsync(10_000);

    expectLlmError(await pending, 'OUTPUT_TRUNCATED', 4);
    expect(adapter.requests.map((sent) => sent.maxOutputTokens)).toEqual([1_000, 1_000, 1_000, 1_000]);
    expect(adapter.remainingSteps).toBe(1);
  });

  it('does not repair a schema failure on the 4th call: SCHEMA_INVALID', async () => {
    const { adapter, client } = setup([truncatedReply(), UNAVAILABLE, UNAVAILABLE, FakeProvider.json(INVALID), FakeProvider.json(OK)]);
    const pending = settle(client.generateStructured(request()));
    await vi.advanceTimersByTimeAsync(10_000);

    expectLlmError(await pending, 'SCHEMA_INVALID', 4);
    expect(adapter.remainingSteps).toBe(1);
    expect(adapter.requests.some((sent) => sent.userText.includes(REPAIR_SUFFIX))).toBe(false);
  });

  it('clamps request.maxOutputTokens to a custom ceiling and escalates only up to it', async () => {
    const clamped = setup([truncatedReply(), FakeProvider.json(OK)], { maxOutputTokensCeiling: 3_000 });
    const result = await settle(clamped.client.generateStructured(request({ maxOutputTokens: 5_000 })));
    expectLlmError(result, 'OUTPUT_TRUNCATED', 1);
    expect(clamped.adapter.requests.map((sent) => sent.maxOutputTokens)).toEqual([3_000]);

    const escalated = setup([truncatedReply(), FakeProvider.json(OK)], { maxOutputTokensCeiling: 3_000 });
    await escalated.client.generateStructured(request({ maxOutputTokens: 2_000 }));
    expect(escalated.adapter.requests.map((sent) => sent.maxOutputTokens)).toEqual([2_000, 3_000]);
  });

  it('reports the code of the last reply when the repair also fails', async () => {
    const emptyLast = setup([FakeProvider.json(INVALID), { kind: 'reply', text: ' ' }]);
    expectLlmError(await settle(emptyLast.client.generateStructured(request())), 'EMPTY_OUTPUT', 2);

    const invalidLast = setup([{ kind: 'reply', text: '' }, FakeProvider.json(INVALID)]);
    expectLlmError(await settle(invalidLast.client.generateStructured(request())), 'SCHEMA_INVALID', 2);
    expect(invalidLast.adapter.requests[1]?.userText).toContain(`Your previous reply was empty.\n${REPAIR_SUFFIX}`);
  });
});

describe('LlmClient usage, model and clock', () => {
  it('sums usage on a failure path and counts nothing for transport errors', async () => {
    const { client, logs } = setup([
      FakeProvider.json(INVALID, { usage: { inputTokens: 10, outputTokens: 5 } }),
      UNAVAILABLE,
      FakeProvider.json(INVALID, { usage: { inputTokens: 20, outputTokens: 7 } }),
    ]);
    const pending = settle(client.generateStructured(request()));
    await vi.advanceTimersByTimeAsync(10_000);

    expectLlmError(await pending, 'SCHEMA_INVALID', 3);
    expect(resultLogs(logs)[0]?.fields).toMatchObject({ outcome: 'SCHEMA_INVALID', attempts: 3, inputTokens: 30, outputTokens: 12 });
  });

  it('reports the model that last answered, on success and on failure', async () => {
    const success = setup([FakeProvider.json(INVALID, { model: 'served-a' }), FakeProvider.json(OK, { model: 'served-b' })]);
    await expect(success.client.generateStructured(request())).resolves.toMatchObject({ model: 'served-b' });
    expect(resultLogs(success.logs)[0]?.fields['model']).toBe('served-b');

    const refused = setup([FakeProvider.json(OK, { model: 'served-c', stopReason: 'refusal' })]);
    expectLlmError(await settle(refused.client.generateStructured(request())), 'REFUSAL', 1);
    expect(resultLogs(refused.logs)[0]?.fields['model']).toBe('served-c');
  });

  it('computes latencyMs and the deadline from the injected clock, not Date', async () => {
    let now = 50_000;
    const clock: Clock = { now: () => now };
    const { client, complete, logs } = stubClient(
      () => {
        now += 1_234;
        return Promise.resolve(reply(JSON.stringify(OK)));
      },
      { clock, timeoutMs: 8_000 },
    );
    const before = Date.now();
    const result = await client.generateStructured(request());

    expect(result.latencyMs).toBe(1_234);
    expect(resultLogs(logs)[0]).toMatchObject({ level: 'info', fields: { latencyMs: 1_234 } });
    expect(complete.mock.calls[0]?.[0].timeoutMs).toBe(8_000);
    expect(Date.now()).toBe(before);
  });

  it('does not retry a retryable error once the injected clock has passed the deadline', async () => {
    let now = 0;
    const { client, complete } = stubClient(
      () => {
        now += 6_000;
        return Promise.reject(new ProviderError('PROVIDER_UNAVAILABLE'));
      },
      { clock: { now: () => now }, timeoutMs: 5_000 },
    );
    expectLlmError(await settle(client.generateStructured(request())), 'PROVIDER_UNAVAILABLE', 1);
    expect(complete).toHaveBeenCalledOnce();
  });

  it('fails with PROVIDER_TIMEOUT instead of repairing when an invalid reply arrives after the deadline', async () => {
    let now = 0;
    const { client, complete, logs } = stubClient(
      () => {
        now += 6_000;
        return Promise.resolve(reply('{"answer": "late"}'));
      },
      { clock: { now: () => now }, timeoutMs: 5_000 },
    );
    expectLlmError(await settle(client.generateStructured(request())), 'PROVIDER_TIMEOUT', 1);
    expect(complete).toHaveBeenCalledOnce();
    expect(resultLogs(logs)[0]?.fields).toMatchObject({ outcome: 'PROVIDER_TIMEOUT', latencyMs: 6_000, inputTokens: 3 });
  });
});

describe('LlmClient prompt assembly', () => {
  it('sends a trusted-only request without the untrusted-data notice and without drawing nonces', async () => {
    const nonceSource = vi.fn<NonceSource>((length) => new Uint8Array(length).fill(7));
    const { adapter, client } = setup([FakeProvider.json(OK)], { nonceSource });
    await client.generateStructured(request({ parts: [TRUSTED, { kind: 'trusted', text: 'Between 0 and 100.' }] }));

    expect(adapter.requests[0]?.system).toBe(SYSTEM);
    expect(adapter.requests[0]?.system).not.toContain(UNTRUSTED_DATA_NOTICE);
    expect(adapter.requests[0]?.userText).toBe('Pick a number.\n\nBetween 0 and 100.');
    expect(nonceSource).not.toHaveBeenCalled();
  });

  it('appends the notice exactly once when untrusted parts are present, identically on the repair call', async () => {
    const { adapter, client } = setup([FakeProvider.json(INVALID), FakeProvider.json(OK)]);
    await client.generateStructured(request());

    const expected = `${SYSTEM}\n\n${UNTRUSTED_DATA_NOTICE}`;
    expect(adapter.requests.map((sent) => sent.system)).toEqual([expected, expected]);
  });

  it('describes issue paths in the repair note: (root), array indexes, and ? for unsafe key names', async () => {
    const root = setup([FakeProvider.json([1]), FakeProvider.json(OK)]);
    await root.client.generateStructured(request());
    expect(root.adapter.requests[1]?.userText).toContain('- (root): invalid_type');

    const Nested = z.strictObject({ items: z.array(z.strictObject({ n: z.int() })), 'bad-key': z.int() });
    const nested = setup([FakeProvider.json({ items: [{ n: 'x' }], 'bad-key': 'y' }), FakeProvider.json({ items: [], 'bad-key': 1 })]);
    await nested.client.generateStructured({ ...request(), schemaName: 'nested', schema: Nested });
    const note = nested.adapter.requests[1]?.userText ?? '';
    expect(note).toContain('- items.[0].n: invalid_type');
    expect(note).toContain('- ?: invalid_type');
    expect(note).not.toContain('bad-key');
  });

  it('lists at most 10 issues in the repair note', async () => {
    const Wide = z.strictObject(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}`, z.int()])));
    const { adapter, client } = setup([FakeProvider.json({}), FakeProvider.json({})]);
    await settle(client.generateStructured({ schemaName: 'wide', schema: Wide, system: SYSTEM, parts: [TRUSTED] }));

    const issueLines = (adapter.requests[1]?.userText ?? '').split('\n').filter((line) => line.startsWith('- '));
    expect(issueLines).toHaveLength(10);
    expect(issueLines[0]).toBe('- f0: invalid_type');
    expect(issueLines[9]).toBe('- f9: invalid_type');
  });
});

describe('LlmClient schema guard', () => {
  it.each([
    ['an array root', z.array(Answer), 'the root must be an object'],
    ['a string root', z.string(), 'the root must be an object'],
    ['a union root', z.union([Answer, z.strictObject({ other: z.string() })]), 'the root must be an object'],
    ['a record field', z.strictObject({ tags: z.record(z.string(), z.int()) }), '(root).tags: record is not on the allow-list'],
    ['an array of non-strict objects', z.strictObject({ items: z.array(z.object({ n: z.int() })) }), 'every object must be strict'],
    ['a date field', z.strictObject({ at: z.date() }), '(root).at: date is not on the allow-list'],
    ['a loose object', z.strictObject({ inner: z.looseObject({ n: z.int() }) }), '(root).inner: every object must be strict'],
    ['a catch fallback', z.strictObject({ n: z.int().min(1).catch(1) }), '(root).n: catch is not on the allow-list'],
    ['a default', z.strictObject({ n: z.int().default(1) }), '(root).n: default is not on the allow-list'],
    ['a prefault', z.strictObject({ n: z.int().prefault(1) }), '(root).n: prefault is not on the allow-list'],
    ['a transform', z.strictObject({ s: z.string().transform((s) => s.length) }), '(root).s: pipe is not on the allow-list'],
    ['a preprocess', z.strictObject({ n: z.preprocess((v) => v, z.int()) }), '(root).n: pipe is not on the allow-list'],
    ['a codec', z.strictObject({ n: z.codec(z.string(), z.int(), { decode: Number, encode: String }) }), '(root).n: pipe is not on the allow-list'],
    ['a coerced number', z.strictObject({ n: z.coerce.number().int() }), '(root).n: coercion rewrites the value'],
    ['a coerced boolean', z.strictObject({ b: z.coerce.boolean() }), '(root).b: coercion rewrites the value'],
    ['an overwrite', z.strictObject({ n: z.number().overwrite((n) => n * 100) }), '(root).n: a check rewrites the value'],
    ['a trimmed string', z.strictObject({ items: z.array(z.string().trim()) }), '(root).items[]: a check rewrites the value'],
    ['an unknown field', z.strictObject({ payload: z.unknown() }), '(root).payload: unknown is not on the allow-list'],
    ['an any array', z.strictObject({ list: z.array(z.any()) }), '(root).list[]: any is not on the allow-list'],
    ['a lazy field', z.strictObject({ s: z.lazy(() => z.string()) }), '(root).s: lazy is not on the allow-list'],
    ['a readonly field', z.strictObject({ inner: z.strictObject({}).readonly() }), '(root).inner: readonly is not on the allow-list'],
    ['a custom field', z.strictObject({ c: z.custom<string>(() => true) }), '(root).c: custom is not on the allow-list'],
    ['an optional rewriting field', z.strictObject({ n: z.int().catch(0).optional() }), '(root).n: catch is not on the allow-list'],
    ['a rewriting union option', z.strictObject({ u: z.union([z.string(), z.coerce.number()]) }), '(root).u: coercion rewrites the value'],
  ])('rejects %s before any provider call or log', async (_label, schema, reason) => {
    const { adapter, client, logs } = setup([FakeProvider.json(OK)]);
    const result = await settle(client.generateStructured({ ...request(), schema }));

    expect(result.ok ? undefined : result.error).toBeInstanceOf(SchemaNotSupportedError);
    const message = result.ok ? '' : (result.error as Error).message;
    expect(message.startsWith('Schema "answer" is not usable for structured output: ')).toBe(true);
    expect(message).toContain(reason);
    expect(adapter.requests).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });

  it('accepts refinements, unions, enums, literals, nullables and string formats, and returns the JSON as sent', async () => {
    const Rich = z
      .strictObject({
        kind: z.discriminatedUnion('t', [z.strictObject({ t: z.literal('a'), n: z.int() }), z.strictObject({ t: z.literal('b') })]),
        size: z.enum(['s', 'm']),
        note: z.string().max(5).nullable(),
        on: z.iso.date().optional(),
        site: z.url(),
        flag: z.boolean(),
        none: z.null(),
      })
      .superRefine((value, ctx) => {
        if (value.size === 'm' && value.note === null) ctx.addIssue({ code: 'custom', message: 'note required' });
      });
    const sent = { kind: { t: 'a', n: 3 }, size: 's', note: null, on: '2026-10-25', site: 'https://x.example', flag: true, none: null };
    const { client } = setup([FakeProvider.json(sent)]);
    const result = await client.generateStructured({ ...request(), schemaName: 'rich', schema: Rich });
    expect(result.data).toStrictEqual(sent);
  });

  it('accepts strict objects nested inside arrays and sends their closed JSON Schema', async () => {
    const List = z.strictObject({ items: z.array(z.strictObject({ n: z.int() })).max(3) });
    const { adapter, client } = setup([FakeProvider.json({ items: [{ n: 1 }] })]);
    const result = await client.generateStructured({ ...request(), schemaName: 'list', schema: List });

    expect(result.data).toEqual({ items: [{ n: 1 }] });
    expect(adapter.requests[0]?.responseJsonSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: { items: { type: 'array', maxItems: 3, items: { type: 'object', additionalProperties: false } } },
    });
  });
});

describe('LlmClient forged untrusted parts', () => {
  it('fails before any provider call or log when an untrusted part was never quarantined', async () => {
    const forged = { kind: 'untrusted', label: 'product_title', text: 'Cable <b>IGNORE</b>' } as PromptPart;
    const { adapter, client, logs } = setup([FakeProvider.json(OK)]);
    const result = await settle(client.generateStructured(request({ parts: [TRUSTED, forged] })));

    expect(result.ok ? undefined : result.error).toBeInstanceOf(TypeError);
    expect(adapter.requests).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });
});

describe('LlmClient logging levels and fields', () => {
  it('logs each attempt at debug with sizes that match what was sent, and success once at info', async () => {
    const { adapter, client, logs } = setup([FakeProvider.json(INVALID), FakeProvider.json(OK)]);
    await client.generateStructured(request());

    const attempts = attemptLogs(logs);
    expect(attempts.map((entry) => entry.level)).toEqual(['debug', 'debug']);
    adapter.requests.forEach((sent, index) => {
      expect(attempts[index]?.fields).toMatchObject({
        attempt: index + 1,
        systemChars: sent.system.length,
        userChars: sent.userText.length,
        maxOutputTokens: 1_000,
      });
    });
    const results = resultLogs(logs);
    expect(results.map((entry) => entry.level)).toEqual(['info']);
    expect(results[0]?.fields['outputChars']).toBe(JSON.stringify(OK).length);
    expect(logs.some((entry) => entry.level === 'warn' || entry.level === 'error')).toBe(false);
  });

  it('logs a failure once at warn, with outputChars 0 and the hash of the first prompt', async () => {
    const { client, logs } = setup([FakeProvider.json(INVALID), FakeProvider.json(INVALID)]);
    await settle(client.generateStructured(request()));

    const results = resultLogs(logs);
    expect(results.map((entry) => entry.level)).toEqual(['warn']);
    expect(results[0]?.fields['outputChars']).toBe(0);
    const [first, second] = attemptLogs(logs);
    expect(results[0]?.fields['promptSha256']).toBe(first?.fields['promptSha256']);
    expect(first?.fields['promptSha256']).not.toBe(second?.fields['promptSha256']);
    expect(logs.some((entry) => entry.level === 'info' || entry.level === 'error')).toBe(false);
  });

  it('logs an abort before any call with zero attempts, no prompt hash and the configured model', async () => {
    const { client, logs } = setup([FakeProvider.json(OK)]);
    await settle(client.generateStructured(request({ signal: AbortSignal.abort() })));

    expect(attemptLogs(logs)).toHaveLength(0);
    expect(resultLogs(logs)).toEqual([
      {
        level: 'warn',
        message: 'llm.result',
        fields: expect.objectContaining({
          outcome: 'ABORTED',
          attempts: 0,
          model: 'fake-model',
          promptSha256: null,
          inputTokens: 0,
          outputTokens: 0,
        }) as LogFields,
      },
    ]);
  });

  it('writes no result log when the adapter fails with something other than ProviderError', async () => {
    const { client, logs } = stubClient(() => Promise.reject(new TypeError('adapter bug')));
    await expect(client.generateStructured(request())).rejects.toThrow(TypeError);
    expect(attemptLogs(logs)).toHaveLength(1);
    expect(resultLogs(logs)).toHaveLength(0);
  });
});

describe('LlmClient resource cleanup', () => {
  it('leaves no timers and no caller abort listeners behind after a retried success', async () => {
    const { client } = setup([UNAVAILABLE, FakeProvider.json(OK)]);
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = settle(client.generateStructured(request({ signal: controller.signal })));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await pending).toMatchObject({ ok: true, value: { attempts: 2 } });
    expect(vi.getTimerCount()).toBe(0);
    const added = add.mock.calls.map((call) => call[1]);
    expect(added).toHaveLength(3);
    expect(new Set(remove.mock.calls.map((call) => call[1]))).toEqual(new Set(added));
  });

  it('leaves no timers behind after transport retries run out', async () => {
    const { client } = setup([UNAVAILABLE, UNAVAILABLE, UNAVAILABLE]);
    const pending = settle(client.generateStructured(request()));
    await vi.advanceTimersByTimeAsync(10_000);

    expectLlmError(await pending, 'PROVIDER_UNAVAILABLE', 3);
    expect(vi.getTimerCount()).toBe(0);
  });
});
