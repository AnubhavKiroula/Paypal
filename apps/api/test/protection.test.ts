import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type AppOptions } from '../src/app.js';
import { loadApiConfig } from '../src/config.js';
import type { Db } from '../src/db/db.js';
import { loadMigrations, migrate } from '../src/db/migrate.js';
import { DEMO_IDS, seed } from '../src/db/seed.js';
import {
  bucketsFor,
  FixedWindowLimiter,
  LlmGate,
  purchaseRequestsToday,
  RATE_LIMITS,
  Rejections,
} from '../src/http/protection.js';
import { PurchaseError, type PurchaseService } from '../src/modules/purchases/service.js';
import type { PaypalWebhookHandler } from '../src/modules/webhooks/paypal.js';
import { createTestDb } from './helpers/pglite.js';

const MANDATE = DEMO_IDS.mandate;
const submitBody = (n = 0) => ({ requesterUserId: DEMO_IDS.requester, text: 'two packs of paper', requestKey: `protect-key-${n}-0000` });

/** Records log calls so tests can check what reaches the logs. */
function memoryLog() {
  const lines: { fields: Record<string, unknown>; message: string }[] = [];
  return { lines, warn: (fields: Record<string, unknown>, message: string) => void lines.push({ fields, message }) };
}

/** A purchase service whose submit() resolves only when the test says so. */
function stubPurchases() {
  const pending: (() => void)[] = [];
  let submitted = 0;
  const service = {
    submit: () => {
      submitted += 1;
      return new Promise((resolve) => pending.push(() => resolve({ view: { id: 'p-1', mandateId: MANDATE, status: 'QUOTED' }, created: true })));
    },
    get: () => Promise.resolve({ id: 'p-1', mandateId: MANDATE, status: 'QUOTED' }),
    previewApproval: () => Promise.reject(new PurchaseError('APPROVAL_NOT_FOUND')),
    decideApproval: () => Promise.reject(new PurchaseError('APPROVAL_NOT_FOUND')),
    capture: () => Promise.reject(new PurchaseError('INVALID_STATE')),
  } as unknown as PurchaseService;
  return { service, finishAll: () => pending.splice(0).forEach((resolve) => resolve()), submitted: () => submitted };
}

let apps: FastifyInstance[] = [];
async function app(options: Partial<AppOptions> = {}): Promise<FastifyInstance> {
  const built = await buildApp({ config: { logLevel: 'silent' }, logger: false, ...options });
  apps.push(built);
  return built;
}
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

const post = (a: FastifyInstance, url: string, payload: unknown, headers: Record<string, string> = {}, remoteAddress = '203.0.113.7') =>
  a.inject({ method: 'POST', url, payload: payload as Record<string, unknown>, headers, remoteAddress });

describe('FixedWindowLimiter (fake clock)', () => {
  it('allows the limit per key and window, then refuses with the time left, then resets', () => {
    let now = 1_000_000;
    const limiter = new FixedWindowLimiter({ limit: 2, windowMs: 60_000, now: () => now });
    expect(limiter.take('a')).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(limiter.take('a')).toEqual({ allowed: true, retryAfterMs: 0 });
    now += 15_000;
    expect(limiter.take('a')).toEqual({ allowed: false, retryAfterMs: 45_000 });
    expect(limiter.take('b').allowed).toBe(true);
    now += 45_000;
    expect(limiter.take('a').allowed).toBe(true);
  });

  it('forgets expired windows so memory stays bounded', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter({ limit: 1, windowMs: 1_000, now: () => now, maxKeys: 10 });
    for (let i = 0; i < 10; i++) limiter.take(`ip-${i}`);
    now += 1_000;
    limiter.take('fresh');
    expect(limiter.size).toBe(1);
  });
});

describe('route buckets', () => {
  it.each([
    ['GET', '/health', []],
    ['GET', '/ready', []],
    ['POST', '/webhooks/paypal', ['webhook']],
    ['POST', '/mandates/:mandateId/purchases', ['global', 'purchase']],
    ['POST', '/approvals/preview', ['global', 'approval']],
    ['POST', '/approvals/decision', ['global', 'approval']],
    ['GET', '/mandates/:mandateId', ['global']],
    ['GET', undefined, ['global']],
  ])('%s %s -> %j', (method, url, buckets) => {
    expect(bucketsFor(method, url)).toEqual(buckets);
  });

  it('has a stricter approval limit than the global one, and a generous webhook limit', () => {
    expect(RATE_LIMITS.approval).toBeLessThan(RATE_LIMITS.global);
    expect(RATE_LIMITS.purchase).toBeLessThan(RATE_LIMITS.approval);
    expect(RATE_LIMITS.webhook).toBeGreaterThan(RATE_LIMITS.global);
  });
});

describe('per-IP rate limits over HTTP', () => {
  it('answers 429 RATE_LIMITED with Retry-After once an IP spends the approval budget, and counts it', async () => {
    const rejections = new Rejections(memoryLog());
    const a = await app({ purchases: stubPurchases().service, protection: { limits: { approval: 2 }, rejections } });
    for (let i = 0; i < 2; i++) expect((await post(a, '/approvals/preview', { token: 'x' })).statusCode).toBe(400);
    const limited = await post(a, '/approvals/preview', { token: 'x' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: 'RATE_LIMITED' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect((await post(a, '/approvals/preview', { token: 'x' }, {}, '198.51.100.9')).statusCode).toBe(400);
    expect(rejections.snapshot()).toEqual({ 'rate_limited:approval': 1 });
  });

  it('never limits /health or /ready, even after the global budget is spent', async () => {
    const a = await app({ protection: { limits: { global: 1 } } });
    await a.inject({ method: 'GET', url: '/nope', remoteAddress: '203.0.113.7' });
    expect((await a.inject({ method: 'GET', url: '/nope', remoteAddress: '203.0.113.7' })).statusCode).toBe(429);
    for (let i = 0; i < 5; i++) {
      expect((await a.inject({ method: 'GET', url: '/health', remoteAddress: '203.0.113.7' })).statusCode).toBe(200);
      expect((await a.inject({ method: 'GET', url: '/ready', remoteAddress: '203.0.113.7' })).statusCode).toBe(200);
    }
  });

  it('keeps the PayPal webhook on its own budget: a spent global budget does not block it', async () => {
    const handler = { handle: () => Promise.resolve({ status: 200 as const }) };
    const a = await app({ paypalWebhooks: handler as unknown as PaypalWebhookHandler, protection: { limits: { global: 1 } } });
    await a.inject({ method: 'GET', url: '/nope', remoteAddress: '203.0.113.7' });
    expect((await a.inject({ method: 'GET', url: '/nope', remoteAddress: '203.0.113.7' })).statusCode).toBe(429);
    const hook = await post(a, '/webhooks/paypal', { id: 'WH-1' });
    expect(hook.statusCode).not.toBe(429);
  });
});

describe('client IP behind a proxy', () => {
  const PROXY = '10.0.0.5';

  it('with the proxy network trusted, uses the address the proxy appended and ignores a spoofed left-most entry', async () => {
    const a = await app({ purchases: stubPurchases().service, protection: { trustedProxies: ['10.0.0.0/8'], limits: { approval: 1 } } });
    const spoof = (fake: string) => post(a, '/approvals/preview', { token: 'x' }, { 'x-forwarded-for': `${fake}, 192.0.2.44` }, PROXY);
    expect((await spoof('1.1.1.1')).statusCode).toBe(400);
    // Same real client (192.0.2.44), different spoofed value: still the same bucket.
    expect((await spoof('8.8.8.8')).statusCode).toBe(429);
    // A different real client is not affected.
    expect((await post(a, '/approvals/preview', { token: 'x' }, { 'x-forwarded-for': '192.0.2.99' }, PROXY)).statusCode).toBe(400);
  });

  it('with no trusted proxies (local), ignores X-Forwarded-For entirely', async () => {
    const a = await app({ purchases: stubPurchases().service, protection: { limits: { approval: 1 } } });
    expect((await post(a, '/approvals/preview', { token: 'x' }, { 'x-forwarded-for': '1.1.1.1' })).statusCode).toBe(400);
    expect((await post(a, '/approvals/preview', { token: 'x' }, { 'x-forwarded-for': '2.2.2.2' })).statusCode).toBe(429);
  });
});

describe('PURCHASES_ENABLED kill switch', () => {
  it('turns off the LLM and payment routes with 503 PURCHASES_DISABLED, and counts it', async () => {
    const stub = stubPurchases();
    const rejections = new Rejections(memoryLog());
    const a = await app({ purchases: stub.service, protection: { purchasesEnabled: false, rejections } });
    const off = [
      await post(a, `/mandates/${MANDATE}/purchases`, submitBody()),
      await post(a, '/approvals/decision', { token: 'a'.repeat(43), decision: 'APPROVE' }),
      await post(a, '/purchases/00000000-0000-4000-8000-000000000001/capture', {}),
    ];
    for (const response of off) {
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: 'PURCHASES_DISABLED' });
    }
    expect(stub.submitted()).toBe(0);
    expect(rejections.snapshot()).toEqual({ purchases_disabled: 3 });
  });

  it('keeps /health, /ready and read routes up', async () => {
    const a = await app({ purchases: stubPurchases().service, protection: { purchasesEnabled: false } });
    expect((await a.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/purchases/00000000-0000-4000-8000-000000000001' })).statusCode).toBe(200);
  });
});

describe('concurrency limit on LLM requests', () => {
  it('answers 503 LLM_BUSY with Retry-After while the in-flight limit is reached, and frees the slot after', async () => {
    const stub = stubPurchases();
    const rejections = new Rejections(memoryLog());
    const a = await app({ purchases: stub.service, protection: { maxConcurrentLlm: 1, countLlmRequestsToday: () => Promise.resolve(0), rejections } });
    const first = post(a, `/mandates/${MANDATE}/purchases`, submitBody(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const busy = await post(a, `/mandates/${MANDATE}/purchases`, submitBody(2), {}, '198.51.100.9');
    expect(busy.statusCode).toBe(503);
    expect(busy.json()).toMatchObject({ error: 'LLM_BUSY' });
    expect(busy.headers['retry-after']).toBeDefined();
    stub.finishAll();
    expect((await first).statusCode).toBe(201);
    const again = post(a, `/mandates/${MANDATE}/purchases`, submitBody(3), {}, '198.51.100.10');
    await new Promise((resolve) => setTimeout(resolve, 20));
    stub.finishAll();
    expect((await again).statusCode).toBe(201);
    expect(rejections.snapshot()).toEqual({ llm_busy: 1 });
  });

  it('frees the slot when the request fails', async () => {
    const gate = new LlmGate({ maxConcurrent: 1, dailyCap: 10, countToday: () => Promise.resolve(0), now: () => 0 });
    const entered = await gate.enter();
    if (!entered.ok) throw new Error('expected a slot');
    expect((await gate.enter()).ok).toBe(false);
    entered.release();
    entered.release();
    expect(gate.inFlight).toBe(0);
    expect((await gate.enter()).ok).toBe(true);
  });
});

describe('daily LLM cap, counted in Postgres', () => {
  let db: Db;
  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db, loadMigrations());
    await seed(db);
  }, 60_000);
  afterAll(async () => {
    await db.close();
  });

  const NOW = new Date('2026-11-08T15:00:00Z');
  const insert = (key: string, createdAt: string) =>
    db.query('INSERT INTO purchase_request (mandate_id, requester_user_id, raw_text, request_key, created_at) VALUES ($1, $2, $3, $4, $5)', [
      MANDATE,
      DEMO_IDS.requester,
      'paper',
      key,
      createdAt,
    ]);

  it('counts only purchase requests created since midnight UTC', async () => {
    await insert('cap-yesterday-1', '2026-11-07T23:59:59Z');
    await insert('cap-today-1', '2026-11-08T00:00:00Z');
    await insert('cap-today-2', '2026-11-08T14:00:00Z');
    expect(await purchaseRequestsToday(db, NOW)).toBe(2);
  });

  it('refuses with LLM_DAILY_CAP once the cap is reached, survives a restart, and resets at midnight UTC', async () => {
    const make = (now: Date) => new LlmGate({ maxConcurrent: 5, dailyCap: 2, countToday: () => purchaseRequestsToday(db, now), now: () => now.getTime() });
    const refused = await make(NOW).enter();
    expect(refused).toEqual({ ok: false, code: 'LLM_DAILY_CAP', retryAfterMs: 9 * 3_600_000 });
    // A new gate (as after a restart or spin-down) reads the same count from the database.
    expect((await make(NOW).enter()).ok).toBe(false);
    expect((await make(new Date('2026-11-09T00:00:01Z')).enter()).ok).toBe(true);
  });

  it('answers 429 LLM_DAILY_CAP over HTTP without calling the service', async () => {
    const stub = stubPurchases();
    const rejections = new Rejections(memoryLog());
    const a = await app({
      purchases: stub.service,
      protection: { dailyLlmCap: 2, countLlmRequestsToday: () => purchaseRequestsToday(db, NOW), now: () => NOW.getTime(), rejections },
    });
    const response = await post(a, `/mandates/${MANDATE}/purchases`, submitBody(9));
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ error: 'LLM_DAILY_CAP' });
    expect(stub.submitted()).toBe(0);
    expect(rejections.snapshot()).toEqual({ llm_daily_cap: 1 });
  });

  it('fails closed: no counter configured means no LLM requests', async () => {
    const stub = stubPurchases();
    const a = await app({ purchases: stub.service });
    const response = await post(a, `/mandates/${MANDATE}/purchases`, submitBody(10));
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'LLM_CAP_UNAVAILABLE' });
    expect(stub.submitted()).toBe(0);
  });
});

describe('body size limit', () => {
  it('refuses bodies over 64 KiB with 413 and counts the rejection', async () => {
    const rejections = new Rejections(memoryLog());
    const a = await app({ purchases: stubPurchases().service, protection: { rejections } });
    const response = await post(a, '/approvals/preview', { token: 'x'.repeat(70 * 1024) });
    expect(response.statusCode).toBe(413);
    expect(rejections.snapshot()).toEqual({ body_too_large: 1 });
  });
});

describe('Rejections', () => {
  it('logs the reason and running count only, never request data', () => {
    const log = memoryLog();
    const rejections = new Rejections(log);
    rejections.count('rate_limited:purchase');
    rejections.count('rate_limited:purchase');
    expect(log.lines).toEqual([
      { fields: { reason: 'rate_limited:purchase', count: 1 }, message: 'request rejected' },
      { fields: { reason: 'rate_limited:purchase', count: 2 }, message: 'request rejected' },
    ]);
  });
});

describe('protection settings in loadApiConfig', () => {
  it('defaults: purchases on, no trusted proxies, cap 100 per day, 2 in flight', () => {
    expect(loadApiConfig({})).toMatchObject({ purchasesEnabled: true, trustedProxies: [], llmDailyRequestCap: 100, llmMaxConcurrent: 2 });
  });

  it('reads explicit values', () => {
    expect(loadApiConfig({ PURCHASES_ENABLED: 'false', TRUST_PROXY: '10.0.0.0/8, 192.168.1.4', LLM_DAILY_REQUEST_CAP: '0', LLM_MAX_CONCURRENT: '4' })).toMatchObject({
      purchasesEnabled: false,
      trustedProxies: ['10.0.0.0/8', '192.168.1.4'],
      llmDailyRequestCap: 0,
      llmMaxConcurrent: 4,
    });
  });

  it.each([
    ['PURCHASES_ENABLED', 'yes'],
    ['TRUST_PROXY', '10.0.0.0/33'],
    ['TRUST_PROXY', 'true'],
    ['TRUST_PROXY', '*'],
    ['LLM_DAILY_REQUEST_CAP', '1.5'],
    ['LLM_MAX_CONCURRENT', '0'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => loadApiConfig({ [name]: value })).toThrow(name);
  });
});
