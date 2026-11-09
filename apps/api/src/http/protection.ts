import { createHash, randomBytes } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Queryable } from '../db/db.js';
import { toBigInt } from '../db/db.js';
import type { ErrorBody } from './errors.js';

// Abuse protection for the public API (#62): per-IP rate limits, a daily cap and a concurrency limit on requests
// that call the LLM, and the PURCHASES_ENABLED kill switch. Rejections are counted and logged without request data.

export type Bucket = 'global' | 'purchase' | 'approval' | 'capture' | 'webhook';

/** Requests per minute per client IP. Approval links get a strict budget to slow token guessing. */
export const RATE_LIMITS: Readonly<Record<Bucket, number>> = { global: 120, approval: 10, capture: 10, purchase: 5, webhook: 600 };

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Retry-After for LLM_BUSY: a purchase request takes about 45-60 s on the free LLM tier. */
const BUSY_RETRY_MS = 30_000;

/**
 * The budgets every route spends, keyed "METHOD /pattern" exactly as Fastify registers it. Every registered route
 * must have an entry, and every entry a route (test/protection.test.ts enumerates the full app), so a new or renamed
 * route cannot silently fall into the wrong bucket. An empty list is an explicit exemption: health checks (Render polls them). The PayPal webhook spends
 * only its own, generous budget, so a busy client can never block PayPal's deliveries.
 */
export const ROUTE_BUCKETS: Readonly<Record<string, readonly Bucket[]>> = {
  'GET /health': [],
  'GET /ready': [],
  'POST /webhooks/paypal': ['webhook'],
  'POST /mandates/:mandateId/purchases': ['global', 'purchase'],
  'POST /approvals/preview': ['global', 'approval'],
  'POST /approvals/decision': ['global', 'approval'],
  // Capture calls PayPal and writes an order event even when refused.
  'POST /purchases/:purchaseId/capture': ['global', 'capture'],
  'GET /purchases/:purchaseId': ['global'],
  'GET /purchases/:purchaseId/audit': ['global'],
  'GET /mandates/:mandateId': ['global'],
  'PATCH /mandates/:mandateId': ['global'],
  'GET /mandates/:mandateId/summary': ['global'],
  'GET /mandates/:mandateId/purchases': ['global'],
  // CORS preflight (@fastify/cors).
  'OPTIONS *': ['global'],
};

/** HEAD follows its GET route. */
const routeKey = (method: string, url: string) => `${method === 'HEAD' ? 'GET' : method} ${url}`;

/** Which budgets a request spends. A request that matched no route (404) spends the global one. */
export function bucketsFor(method: string, url: string | undefined): readonly Bucket[] {
  return url === undefined ? ['global'] : (ROUTE_BUCKETS[routeKey(method, url)] ?? ['global']);
}

/**
 * The identity a client's limits are keyed on. IPv4 stays as is, and an IPv4-mapped IPv6 address (::ffff:a.b.c.d)
 * counts as that IPv4 client. IPv6 is keyed by its /64, because one end user usually gets a whole /64 and could
 * otherwise rotate addresses for a fresh budget each time.
 */
export function clientKey(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1] && isIPv4(mapped[1])) return mapped[1];
  const address = ip.split('%')[0] ?? ip;
  if (!isIPv6(address)) return ip;
  const [head = '', tail = ''] = address.toLowerCase().split('::');
  const left = head === '' ? [] : head.split(':');
  const right = address.includes('::') ? (tail === '' ? [] : tail.split(':')) : [];
  const groups = address.includes('::') ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right] : left;
  return `${groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(':')}::/64`;
}

/**
 * Fixed-window counter per key, in memory: a restart resets it, which is fine for per-minute limits. Memory is a hard
 * cap of maxKeys entries. The Map keeps insertion order and a key is re-inserted whenever its window restarts, so the
 * first key is always the oldest window: a new key past the cap evicts it in O(1), never by scanning the map. An
 * evicted client simply starts a fresh window, so under a flood of distinct addresses the oldest lose their history.
 */
export class FixedWindowLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #maxKeys: number;
  readonly #windows = new Map<string, { start: number; count: number }>();

  constructor(options: { limit: number; windowMs: number; now: () => number; maxKeys?: number }) {
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#now = options.now;
    this.#maxKeys = options.maxKeys ?? 50_000;
  }

  get size(): number {
    return this.#windows.size;
  }

  take(key: string): { allowed: boolean; retryAfterMs: number } {
    const now = this.#now();
    const window = this.#windows.get(key);
    if (window && now - window.start < this.#windowMs) {
      if (window.count >= this.#limit) return { allowed: false, retryAfterMs: window.start + this.#windowMs - now };
      window.count += 1;
      return { allowed: true, retryAfterMs: 0 };
    }
    // A new or restarted window goes to the end of the insertion order.
    if (window) this.#windows.delete(key);
    else if (this.#windows.size >= this.#maxKeys) {
      const oldest = this.#windows.keys().next();
      if (!oldest.done) this.#windows.delete(oldest.value);
    }
    this.#windows.set(key, { start: now, count: 1 });
    return { allowed: true, retryAfterMs: 0 };
  }
}

/** Counts rejections by reason. Logs the reason and the running count only: never bodies, headers or IPs. */
export class Rejections {
  readonly #counts = new Map<string, number>();
  readonly #log: { warn(fields: Record<string, unknown>, message: string): void };

  constructor(log: { warn(fields: Record<string, unknown>, message: string): void }) {
    this.#log = log;
  }

  count(reason: string): void {
    const count = (this.#counts.get(reason) ?? 0) + 1;
    this.#counts.set(reason, count);
    this.#log.warn({ reason, count }, 'request rejected');
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.#counts);
  }
}

export type GateRefusal = {
  ok: false;
  code: 'LLM_BUSY' | 'LLM_DAILY_CAP' | 'LLM_DAILY_CLIENT_CAP' | 'LLM_CAP_UNAVAILABLE';
  retryAfterMs: number;
};

const untilMidnightUtc = (now: number) => DAY_MS - (now % DAY_MS);

/**
 * Per-client daily quota on LLM requests, below the global cap, so one client cannot use up the day for everyone.
 * In memory, and so reset by a restart or the free plan's spin-down: the Postgres-backed global cap still holds then.
 * Keys are salted SHA-256 hashes of clientKey(), never raw IPs; the salt is random per process. Bounded to maxKeys
 * entries with O(1) oldest-first eviction, like FixedWindowLimiter.
 */
export class ClientDailyQuota {
  readonly #perClientCap: number;
  readonly #now: () => number;
  readonly #maxKeys: number;
  readonly #salt = randomBytes(16);
  readonly #counts = new Map<string, { day: number; count: number }>();

  constructor(options: { perClientCap: number; now: () => number; maxKeys?: number }) {
    this.#perClientCap = options.perClientCap;
    this.#now = options.now;
    this.#maxKeys = options.maxKeys ?? 50_000;
  }

  /** Spends one request of today's quota, or refuses until midnight UTC. Synchronous, so concurrent calls cannot race. */
  take(client: string): { allowed: boolean; retryAfterMs: number } {
    const now = this.#now();
    const day = Math.floor(now / DAY_MS);
    const key = this.#hash(client);
    const entry = this.#counts.get(key);
    if (entry && entry.day === day) {
      if (entry.count >= this.#perClientCap) return { allowed: false, retryAfterMs: untilMidnightUtc(now) };
      entry.count += 1;
      return { allowed: true, retryAfterMs: 0 };
    }
    if (entry) this.#counts.delete(key);
    else if (this.#counts.size >= this.#maxKeys) {
      const oldest = this.#counts.keys().next();
      if (!oldest.done) this.#counts.delete(oldest.value);
    }
    if (this.#perClientCap < 1) return { allowed: false, retryAfterMs: untilMidnightUtc(now) };
    this.#counts.set(key, { day, count: 1 });
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Gives back a request taken today, when a later check refused it. */
  refund(client: string): void {
    const entry = this.#counts.get(this.#hash(client));
    if (entry && entry.day === Math.floor(this.#now() / DAY_MS) && entry.count > 0) entry.count -= 1;
  }

  /** The stored keys (hashes), for tests: proves no raw IP is kept. */
  storedKeys(): string[] {
    return [...this.#counts.keys()];
  }

  #hash(client: string): string {
    return createHash('sha256').update(this.#salt).update(client).digest('hex').slice(0, 32);
  }
}

export interface GateLog {
  error(fields: Record<string, unknown>, message: string): void;
}

/** IPv4 and IPv6 literals, so a database error message never carries an address into the logs. */
const ADDRESS = /\b(?:\d{1,3}\.){3}\d{1,3}\b|(?:[0-9a-f]{1,4})?(?::[0-9a-f]{0,4}){2,7}(?:%[\w.]+)?/gi;

/** The message (addresses redacted, at most 200 characters) and code of a failed query: never rows, SQL or parameters. */
export function safeDbError(error: unknown): { message: string; code?: string } {
  const message = (error instanceof Error ? error.message : 'unknown error').replace(ADDRESS, '[address]').slice(0, 200);
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  return code === undefined ? { message } : { message, code };
}

/**
 * Admits a request that will call the LLM. The concurrency slot is taken first, so concurrent requests cannot
 * all pass the daily count at once: the cap can be overshot by at most maxConcurrent - 1. The per-client quota is
 * spent next, synchronously, and refunded if the global cap then refuses. The global count comes from Postgres, so
 * it survives restarts and the free plan's spin-down. If the count cannot be read, it fails closed.
 */
export class LlmGate {
  readonly #maxConcurrent: number;
  readonly #dailyCap: number;
  readonly #countToday: (() => Promise<number>) | undefined;
  readonly #now: () => number;
  readonly #clientQuota: ClientDailyQuota | undefined;
  readonly #log: GateLog | undefined;
  #inFlight = 0;

  constructor(options: {
    maxConcurrent: number;
    dailyCap: number;
    countToday?: () => Promise<number>;
    now: () => number;
    clientQuota?: ClientDailyQuota;
    log?: GateLog;
  }) {
    this.#maxConcurrent = options.maxConcurrent;
    this.#dailyCap = options.dailyCap;
    this.#countToday = options.countToday;
    this.#now = options.now;
    this.#clientQuota = options.clientQuota;
    this.#log = options.log;
  }

  get inFlight(): number {
    return this.#inFlight;
  }

  /** `client` is clientKey(request.ip); without it (tests, jobs) only the global limits apply. */
  async enter(client?: string): Promise<{ ok: true; release: () => void } | GateRefusal> {
    if (this.#inFlight >= this.#maxConcurrent) return { ok: false, code: 'LLM_BUSY', retryAfterMs: BUSY_RETRY_MS };
    this.#inFlight += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.#inFlight -= 1;
    };

    const quota = client === undefined ? undefined : this.#clientQuota;
    if (quota && client !== undefined) {
      const spent = quota.take(client);
      if (!spent.allowed) {
        release();
        return { ok: false, code: 'LLM_DAILY_CLIENT_CAP', retryAfterMs: spent.retryAfterMs };
      }
    }
    const refuse = (code: GateRefusal['code'], retryAfterMs: number): GateRefusal => {
      if (quota && client !== undefined) quota.refund(client);
      release();
      return { ok: false, code, retryAfterMs };
    };

    let today: number;
    try {
      if (!this.#countToday) throw new Error('no counter');
      today = await this.#countToday();
    } catch (error) {
      if (this.#countToday) this.#log?.error({ err: safeDbError(error) }, 'llm daily count failed');
      return refuse('LLM_CAP_UNAVAILABLE', BUSY_RETRY_MS);
    }
    if (today >= this.#dailyCap) return refuse('LLM_DAILY_CAP', untilMidnightUtc(this.#now()));
    return { ok: true, release };
  }
}

/** Purchase requests created since midnight UTC. Each one is what triggers LLM calls (intent, then ranking). */
export async function purchaseRequestsToday(db: Queryable, now: Date): Promise<number> {
  const midnight = new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
  const { rows } = await db.query<{ n: unknown }>('SELECT count(*) AS n FROM purchase_request WHERE created_at >= $1', [midnight]);
  return Number(toBigInt(rows[0]?.n ?? 0));
}

const STATUS: Record<'RATE_LIMITED' | 'PURCHASES_DISABLED' | GateRefusal['code'], number> = {
  RATE_LIMITED: 429,
  LLM_DAILY_CAP: 429,
  LLM_DAILY_CLIENT_CAP: 429,
  LLM_BUSY: 503,
  LLM_CAP_UNAVAILABLE: 503,
  PURCHASES_DISABLED: 503,
};

/** Sends a protection refusal in the API's usual error shape, with Retry-After in whole seconds when known. */
export function refuse(request: FastifyRequest, reply: FastifyReply, code: keyof typeof STATUS, retryAfterMs?: number): FastifyReply {
  if (retryAfterMs !== undefined) void reply.header('retry-after', String(Math.max(1, Math.ceil(retryAfterMs / 1_000))));
  return reply.status(STATUS[code]).send({ error: code, message: 'Request rejected', requestId: request.id } satisfies ErrorBody);
}

export interface ProtectionOptions {
  /** PURCHASES_ENABLED. Off: the LLM and payment routes answer 503; reads, /health and /ready stay up. */
  purchasesEnabled?: boolean;
  /** Per-bucket overrides of RATE_LIMITS (tests use small ones). */
  limits?: Partial<Record<Bucket, number>>;
  maxConcurrentLlm?: number;
  /** LLM_DAILY_PER_IP_CAP: LLM requests per client per UTC day (in memory, below the global cap). */
  dailyLlmPerClientCap?: number;
  dailyLlmCap?: number;
  /** Today's LLM-consuming requests, from Postgres. Without it, LLM requests are refused (fail closed). */
  countLlmRequestsToday?: () => Promise<number>;
  now?: () => number;
  rejections?: Rejections;
  /** DEBUG_PROXY_HOPS: log how the client IP was derived, to verify TRUST_PROXY on the deployed API. Off by default. */
  debugProxyHops?: boolean;
  /** Where the diagnostic goes; defaults to the app logger (tests capture it). */
  diagnosticLog?: { info(fields: Record<string, unknown>, message: string): void };
}

/**
 * Logs, per request, how many X-Forwarded-For hops arrived, which hop became request.ip (0: the socket peer, i.e. the
 * proxy itself was not trusted; 1: the right-most forwarded entry; and so on) and a salted hash of the client key.
 * The hash is stable for one client within a process and never reversible to the IP: no raw address is logged.
 */
function installProxyDiagnostic(app: FastifyInstance, log: NonNullable<ProtectionOptions['diagnosticLog']>): void {
  const salt = randomBytes(16);
  app.addHook('onRequest', (request, _reply, done) => {
    const entries = [request.headers['x-forwarded-for'] ?? []]
      .flat()
      .join(',')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    const chain = [request.socket.remoteAddress ?? '', ...[...entries].reverse()];
    const clientHash = createHash('sha256').update(salt).update(clientKey(request.ip)).digest('hex').slice(0, 16);
    log.info({ xffHops: entries.length, pickedHop: chain.indexOf(request.ip), clientHash }, 'proxy diagnostic');
    done();
  });
}

/** What the purchase routes need to enforce the kill switch and the LLM gate. */
export interface PurchaseGuard {
  purchasesEnabled: boolean;
  gate: LlmGate;
  rejections: Rejections;
}

/**
 * Installs the per-IP rate limits (onRequest, before the body is parsed) and counts body-limit rejections.
 * request.ip is only as trustworthy as the trustProxy setting the app was built with (TRUST_PROXY).
 */
export function installProtection(app: FastifyInstance, options: ProtectionOptions = {}): PurchaseGuard {
  const now = options.now ?? Date.now;
  const rejections = options.rejections ?? new Rejections(app.log);
  // First, so requests the limits refuse are diagnosed too.
  if (options.debugProxyHops) installProxyDiagnostic(app, options.diagnosticLog ?? app.log);
  const limiters = Object.fromEntries(
    (Object.keys(RATE_LIMITS) as Bucket[]).map((bucket) => [
      bucket,
      new FixedWindowLimiter({ limit: options.limits?.[bucket] ?? RATE_LIMITS[bucket], windowMs: MINUTE_MS, now }),
    ]),
  ) as Record<Bucket, FixedWindowLimiter>;

  app.addHook('onRequest', async (request, reply) => {
    for (const bucket of bucketsFor(request.method, request.routeOptions.url)) {
      const decision = limiters[bucket].take(clientKey(request.ip));
      if (!decision.allowed) {
        rejections.count(`rate_limited:${bucket}`);
        return refuse(request, reply, 'RATE_LIMITED', decision.retryAfterMs);
      }
    }
    return undefined;
  });
  app.addHook('onResponse', async (_request, reply) => {
    if (reply.statusCode === 413) rejections.count('body_too_large');
  });

  return {
    purchasesEnabled: options.purchasesEnabled ?? true,
    rejections,
    gate: new LlmGate({
      maxConcurrent: options.maxConcurrentLlm ?? 2,
      clientQuota: new ClientDailyQuota({ perClientCap: options.dailyLlmPerClientCap ?? 20, now }),
      log: app.log,
      dailyCap: options.dailyLlmCap ?? 100,
      now,
      ...(options.countLlmRequestsToday ? { countToday: options.countLlmRequestsToday } : {}),
    }),
  };
}
