import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type AppOptions } from '../src/app.js';
import { loadApiConfig } from '../src/config.js';
import type { Db } from '../src/db/db.js';
import { loadMigrations, migrate } from '../src/db/migrate.js';
import { DEMO_IDS, seed } from '../src/db/seed.js';
import {
  bucketsFor,
  ClientDailyQuota,
  clientKey,
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

/** Request keys the stub treats as already stored (idempotent replays). */
const STORED_KEY = 'protect-stored-0000';

/** A purchase service whose submit() resolves only when the test says so. */
function stubPurchases() {
  const pending: (() => void)[] = [];
  let submitted = 0;
  const service = {
    replay: (input: { requestKey: string }) =>
      Promise.resolve(input.requestKey === STORED_KEY ? { id: 'p-stored', mandateId: MANDATE, status: 'CAPTURED' } : undefined),
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

  it('never holds more than maxKeys, even when every window is still live, evicting the oldest first (finding 5)', () => {
    const now = 0; // a frozen clock: no window ever expires
    const limiter = new FixedWindowLimiter({ limit: 1, windowMs: 60_000, now: () => now, maxKeys: 10 });
    for (let i = 0; i < 1_000; i++) {
      limiter.take(`ip-${i}`);
      expect(limiter.size).toBeLessThanOrEqual(10);
    }
    // The newest keys are still limited; the oldest were evicted and start a fresh window.
    expect(limiter.take('ip-999').allowed).toBe(false);
    expect(limiter.take('ip-0').allowed).toBe(true);
  });

  it('keeps take() cheap when the map is full of live windows (no full-map scan per request)', () => {
    const now = 0;
    const maxKeys = 20_000;
    const limiter = new FixedWindowLimiter({ limit: 5, windowMs: 60_000, now: () => now, maxKeys });
    for (let i = 0; i < maxKeys; i++) limiter.take(`fill-${i}`);
    const started = performance.now();
    // A scan per insert would cost maxKeys^2 = 4e8 steps here; eviction costs one step each.
    for (let i = 0; i < maxKeys; i++) limiter.take(`new-${i}`);
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(limiter.size).toBe(maxKeys);
  });

  it('evicts expired windows lazily, oldest first, so memory stays at most maxKeys', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter({ limit: 1, windowMs: 1_000, now: () => now, maxKeys: 10 });
    for (let i = 0; i < 10; i++) limiter.take(`ip-${i}`);
    now += 1_000;
    expect(limiter.take('fresh').allowed).toBe(true);
    expect(limiter.size).toBe(10);
    // An expired window restarts and moves to the back, so it is not the next one evicted.
    expect(limiter.take('ip-1').allowed).toBe(true);
    limiter.take('another');
    expect(limiter.take('ip-1').allowed).toBe(false);
  });
});

describe('clientKey (finding 7)', () => {
  it.each([
    ['192.0.2.1', '192.0.2.1'],
    ['::ffff:192.0.2.1', '192.0.2.1'],
    ['::FFFF:192.0.2.1', '192.0.2.1'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:0db8:0001:0002:ffff::1', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
  ])('%s -> %s', (ip, key) => {
    expect(clientKey(ip)).toBe(key);
  });

  it('keeps clients in different /64 networks apart', () => {
    expect(clientKey('2001:db8:1:2::1')).not.toBe(clientKey('2001:db8:1:3::1'));
  });

  it('shares one rate-limit budget across a /64 over HTTP', async () => {
    const a = await app({ purchases: stubPurchases().service, protection: { limits: { approval: 1 } } });
    expect((await post(a, '/approvals/preview', { token: 'x' }, {}, '2001:db8:1:2::1')).statusCode).toBe(400);
    expect((await post(a, '/approvals/preview', { token: 'x' }, {}, '2001:db8:1:2::ffff')).statusCode).toBe(429);
    expect((await post(a, '/approvals/preview', { token: 'x' }, {}, '2001:db8:1:3::1')).statusCode).toBe(400);
  });

  it('treats an IPv4-mapped IPv6 address as the IPv4 client over HTTP', async () => {
    const a = await app({ purchases: stubPurchases().service, protection: { limits: { approval: 1 } } });
    expect((await post(a, '/approvals/preview', { token: 'x' }, {}, '192.0.2.50')).statusCode).toBe(400);
    expect((await post(a, '/approvals/preview', { token: 'x' }, {}, '::ffff:192.0.2.50')).statusCode).toBe(429);
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
    ['POST', '/purchases/:purchaseId/capture', ['global', 'capture']],
    ['GET', '/mandates/:mandateId', ['global']],
    ['GET', undefined, ['global']],
  ])('%s %s -> %j', (method, url, buckets) => {
    expect(bucketsFor(method, url)).toEqual(buckets);
  });

  it('gives capture its own strict bucket, 10 per minute by default (finding 6)', async () => {
    expect(RATE_LIMITS.capture).toBe(10);
    const a = await app({ purchases: stubPurchases().service, protection: { limits: { capture: 1 } } });
    const capture = () => post(a, '/purchases/00000000-0000-4000-8000-000000000001/capture', {});
    expect((await capture()).statusCode).toBe(409);
    const limited = await capture();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: 'RATE_LIMITED' });
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

  it('lets a REJECT decision through to the service, so the hold can be released (finding 2)', async () => {
    let decided: string | undefined;
    const service = {
      ...stubPurchases().service,
      decideApproval: (_token: string, decision: string) => {
        decided = decision;
        return Promise.resolve({ id: 'p-1', mandateId: MANDATE, status: 'REJECTED' });
      },
    } as unknown as PurchaseService;
    const a = await app({ purchases: service, protection: { purchasesEnabled: false } });
    const rejected = await post(a, '/approvals/decision', { token: 'a'.repeat(43), decision: 'REJECT' });
    expect(rejected.statusCode).toBe(200);
    expect(decided).toBe('REJECT');
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

  it('answers an idempotent replay from the database before the gate, even with the gate full and the cap reached (finding 4)', async () => {
    const stub = stubPurchases();
    const rejections = new Rejections(memoryLog());
    const a = await app({
      purchases: stub.service,
      protection: { maxConcurrentLlm: 1, dailyLlmCap: 1, countLlmRequestsToday: () => Promise.resolve(0), rejections },
    });
    // Fill the only slot with a new request that stays in flight.
    const inFlight = post(a, `/mandates/${MANDATE}/purchases`, submitBody(20));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const replay = await post(a, `/mandates/${MANDATE}/purchases`, { ...submitBody(), requestKey: STORED_KEY }, {}, '198.51.100.30');
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ id: 'p-stored', status: 'CAPTURED' });
    stub.finishAll();
    await inFlight;
    expect(stub.submitted()).toBe(1);
    expect(rejections.snapshot()).toEqual({});
  });

  it('answers a replay while the kill switch is off: it is a read', async () => {
    const stub = stubPurchases();
    const a = await app({ purchases: stub.service, protection: { purchasesEnabled: false } });
    const replay = await post(a, `/mandates/${MANDATE}/purchases`, { ...submitBody(), requestKey: STORED_KEY });
    expect(replay.statusCode).toBe(200);
    expect(stub.submitted()).toBe(0);
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

describe('per-client daily LLM quota (finding 3)', () => {
  const NOON = Date.parse('2026-11-08T12:00:00Z');

  it('refuses a client past its quota with LLM_DAILY_CLIENT_CAP until midnight UTC, others unaffected', () => {
    let now = NOON;
    const quota = new ClientDailyQuota({ perClientCap: 2, now: () => now });
    expect(quota.take('192.0.2.1')).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(quota.take('192.0.2.1').allowed).toBe(true);
    expect(quota.take('192.0.2.1')).toEqual({ allowed: false, retryAfterMs: 12 * 3_600_000 });
    expect(quota.take('192.0.2.2').allowed).toBe(true);
    now = Date.parse('2026-11-09T00:00:00Z');
    expect(quota.take('192.0.2.1').allowed).toBe(true);
  });

  it('gives a slot back when it is refunded', () => {
    const quota = new ClientDailyQuota({ perClientCap: 1, now: () => NOON });
    expect(quota.take('192.0.2.1').allowed).toBe(true);
    quota.refund('192.0.2.1');
    expect(quota.take('192.0.2.1').allowed).toBe(true);
    expect(quota.take('192.0.2.1').allowed).toBe(false);
  });

  it('stores salted hashes, never raw IPs', () => {
    const quota = new ClientDailyQuota({ perClientCap: 5, now: () => NOON });
    quota.take('192.0.2.77');
    quota.take('2001:db8:1:2::/64');
    const stored = quota.storedKeys();
    expect(stored).toHaveLength(2);
    expect(stored.join(' ')).not.toMatch(/192\.0\.2\.77|2001:db8/);
    // Another process (another salt) derives different keys.
    const other = new ClientDailyQuota({ perClientCap: 5, now: () => NOON });
    other.take('192.0.2.77');
    expect(other.storedKeys()[0]).not.toBe(stored[0]);
  });

  it('is bounded: never more than maxKeys clients, oldest evicted first', () => {
    const quota = new ClientDailyQuota({ perClientCap: 1, now: () => NOON, maxKeys: 5 });
    for (let i = 0; i < 100; i++) {
      quota.take(`198.51.100.${i}`);
      expect(quota.storedKeys().length).toBeLessThanOrEqual(5);
    }
    expect(quota.take('198.51.100.99').allowed).toBe(false);
  });

  it('is enforced inside the gate before the global count, and refunded if the global cap refuses', async () => {
    let today = 0;
    const quota = new ClientDailyQuota({ perClientCap: 1, now: () => NOON });
    const gate = new LlmGate({ maxConcurrent: 5, dailyCap: 1, countToday: () => Promise.resolve(today), now: () => NOON, clientQuota: quota });
    today = 1; // global cap reached
    expect(await gate.enter('192.0.2.9')).toMatchObject({ ok: false, code: 'LLM_DAILY_CAP' });
    today = 0;
    const admitted = await gate.enter('192.0.2.9');
    expect(admitted.ok).toBe(true);
    if (admitted.ok) admitted.release();
    expect(await gate.enter('192.0.2.9')).toEqual({ ok: false, code: 'LLM_DAILY_CLIENT_CAP', retryAfterMs: 12 * 3_600_000 });
  });

  it('answers 429 LLM_DAILY_CLIENT_CAP over HTTP per client, and counts it', async () => {
    const stub = stubPurchases();
    const rejections = new Rejections(memoryLog());
    const a = await app({
      purchases: stub.service,
      protection: { dailyLlmPerClientCap: 1, countLlmRequestsToday: () => Promise.resolve(0), rejections },
    });
    const first = post(a, `/mandates/${MANDATE}/purchases`, submitBody(30), {}, '203.0.113.40');
    await new Promise((resolve) => setTimeout(resolve, 20));
    stub.finishAll();
    expect((await first).statusCode).toBe(201);
    const second = await post(a, `/mandates/${MANDATE}/purchases`, submitBody(31), {}, '203.0.113.40');
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({ error: 'LLM_DAILY_CLIENT_CAP' });
    const other = post(a, `/mandates/${MANDATE}/purchases`, submitBody(32), {}, '203.0.113.41');
    await new Promise((resolve) => setTimeout(resolve, 20));
    stub.finishAll();
    expect((await other).statusCode).toBe(201);
    expect(rejections.snapshot()).toEqual({ llm_daily_client_cap: 1 });
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
  it('defaults: purchases on, no trusted proxies, cap 100 per day and 20 per client, 2 in flight', () => {
    expect(loadApiConfig({})).toMatchObject({ purchasesEnabled: true, trustedProxies: [], llmDailyRequestCap: 100, llmDailyPerIpCap: 20, llmMaxConcurrent: 2 });
  });

  it('reads the per-client quota', () => {
    expect(loadApiConfig({ LLM_DAILY_PER_IP_CAP: '5' })).toMatchObject({ llmDailyPerIpCap: 5 });
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
    ['LLM_DAILY_PER_IP_CAP', '-1'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => loadApiConfig({ [name]: value })).toThrow(name);
  });
});
