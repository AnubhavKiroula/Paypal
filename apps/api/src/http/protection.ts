import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Queryable } from '../db/db.js';
import { toBigInt } from '../db/db.js';
import type { ErrorBody } from './errors.js';

// Abuse protection for the public API (#62): per-IP rate limits, a daily cap and a concurrency limit on requests
// that call the LLM, and the PURCHASES_ENABLED kill switch. Rejections are counted and logged without request data.

export type Bucket = 'global' | 'purchase' | 'approval' | 'webhook';

/** Requests per minute per client IP. Approval links get a strict budget to slow token guessing. */
export const RATE_LIMITS: Readonly<Record<Bucket, number>> = { global: 120, approval: 10, purchase: 5, webhook: 600 };

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Retry-After for LLM_BUSY: a purchase request takes about 45-60 s on the free LLM tier. */
const BUSY_RETRY_MS = 30_000;

/**
 * Which budgets a route spends. Health checks spend none (Render polls them). The PayPal webhook spends only its
 * own, generous budget, so a busy client can never block PayPal's deliveries. `url` is Fastify's route pattern.
 */
export function bucketsFor(method: string, url: string | undefined): Bucket[] {
  if (url === '/health' || url === '/ready') return [];
  if (url === '/webhooks/paypal') return ['webhook'];
  if (method === 'POST' && url === '/mandates/:mandateId/purchases') return ['global', 'purchase'];
  if (url === '/approvals/preview' || url === '/approvals/decision') return ['global', 'approval'];
  return ['global'];
}

/** Fixed-window counter per key. In memory: a restart resets it, which is fine for per-minute limits. */
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
    if (this.#windows.size >= this.#maxKeys) this.#prune(now);
    const window = this.#windows.get(key);
    if (!window || now - window.start >= this.#windowMs) {
      this.#windows.set(key, { start: now, count: 1 });
      return { allowed: true, retryAfterMs: 0 };
    }
    if (window.count < this.#limit) {
      window.count += 1;
      return { allowed: true, retryAfterMs: 0 };
    }
    return { allowed: false, retryAfterMs: window.start + this.#windowMs - now };
  }

  #prune(now: number): void {
    for (const [key, window] of this.#windows) if (now - window.start >= this.#windowMs) this.#windows.delete(key);
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

export type GateRefusal = { ok: false; code: 'LLM_BUSY' | 'LLM_DAILY_CAP' | 'LLM_CAP_UNAVAILABLE'; retryAfterMs: number };

/**
 * Admits a request that will call the LLM. The concurrency slot is taken first, so concurrent requests cannot
 * all pass the daily count at once: the cap can be overshot by at most maxConcurrent - 1. The count comes from
 * Postgres, so it survives restarts and the free plan's spin-down. If the count cannot be read, it fails closed.
 */
export class LlmGate {
  readonly #maxConcurrent: number;
  readonly #dailyCap: number;
  readonly #countToday: (() => Promise<number>) | undefined;
  readonly #now: () => number;
  #inFlight = 0;

  constructor(options: { maxConcurrent: number; dailyCap: number; countToday?: () => Promise<number>; now: () => number }) {
    this.#maxConcurrent = options.maxConcurrent;
    this.#dailyCap = options.dailyCap;
    this.#countToday = options.countToday;
    this.#now = options.now;
  }

  get inFlight(): number {
    return this.#inFlight;
  }

  async enter(): Promise<{ ok: true; release: () => void } | GateRefusal> {
    if (this.#inFlight >= this.#maxConcurrent) return { ok: false, code: 'LLM_BUSY', retryAfterMs: BUSY_RETRY_MS };
    this.#inFlight += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.#inFlight -= 1;
    };

    let today: number;
    try {
      if (!this.#countToday) throw new Error('no counter');
      today = await this.#countToday();
    } catch {
      release();
      return { ok: false, code: 'LLM_CAP_UNAVAILABLE', retryAfterMs: BUSY_RETRY_MS };
    }
    if (today >= this.#dailyCap) {
      release();
      const now = this.#now();
      return { ok: false, code: 'LLM_DAILY_CAP', retryAfterMs: DAY_MS - (now % DAY_MS) };
    }
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
  dailyLlmCap?: number;
  /** Today's LLM-consuming requests, from Postgres. Without it, LLM requests are refused (fail closed). */
  countLlmRequestsToday?: () => Promise<number>;
  now?: () => number;
  rejections?: Rejections;
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
  const limiters = Object.fromEntries(
    (Object.keys(RATE_LIMITS) as Bucket[]).map((bucket) => [
      bucket,
      new FixedWindowLimiter({ limit: options.limits?.[bucket] ?? RATE_LIMITS[bucket], windowMs: MINUTE_MS, now }),
    ]),
  ) as Record<Bucket, FixedWindowLimiter>;

  app.addHook('onRequest', async (request, reply) => {
    for (const bucket of bucketsFor(request.method, request.routeOptions.url)) {
      const decision = limiters[bucket].take(request.ip);
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
      dailyCap: options.dailyLlmCap ?? 100,
      now,
      ...(options.countLlmRequestsToday ? { countToday: options.countLlmRequestsToday } : {}),
    }),
  };
}
