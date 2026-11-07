import { randomUUID } from 'node:crypto';
import { DEMO_IDS } from '../db/seed.js';

// Checks a deployed API from the outside (`pnpm smoke:deployed <apiUrl>`). Prints status codes and short facts only,
// never response bodies, headers or configuration, so its output is safe to paste into a PR.

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface SmokeOptions {
  apiUrl: string;
  /** The web app's origin: checks the API's CORS answer for it. */
  webOrigin?: string;
  /** Also submits one purchase request. Off by default: an ALLOW holds demo budget and opens a sandbox PayPal order. */
  purchase?: boolean;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const PURCHASE_TEXT = 'Two packs of printer paper for the office';

/** Only plain strings from a response reach the output; anything else prints as the fallback. */
const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

export async function runSmoke(options: SmokeOptions): Promise<Check[]> {
  const base = new URL(options.apiUrl).origin;
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 90_000;
  const call = async (path: string, init: RequestInit = {}) => {
    const started = Date.now();
    const response = await doFetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    return { status: response.status, headers: response.headers, body: body as Record<string, unknown> | undefined, ms: Date.now() - started };
  };

  const checks: Check[] = [];
  const check = async (name: string, run: () => Promise<{ ok: boolean; detail: string }>) => {
    try {
      checks.push({ name, ...(await run()) });
    } catch (error) {
      checks.push({ name, ok: false, detail: error instanceof Error ? error.name : 'error' });
    }
  };

  // The first call also measures a free-plan cold start.
  await check('health', async () => {
    const r = await call('/health');
    return { ok: r.status === 200 && r.body?.['status'] === 'ok', detail: `HTTP ${r.status} in ${r.ms} ms` };
  });
  await check('ready (postgres)', async () => {
    const r = await call('/ready');
    const postgres = (r.body?.['checks'] as Record<string, unknown> | undefined)?.['postgres'];
    return { ok: r.status === 200 && postgres === 'ok', detail: `HTTP ${r.status}, postgres ${String(postgres)}` };
  });
  await check('demo mandate', async () => {
    const r = await call(`/mandates/${DEMO_IDS.mandate}`);
    return { ok: r.status === 200, detail: r.status === 200 ? 'HTTP 200' : `HTTP ${r.status} ${str(r.body?.['error'])} (seeded?)` };
  });
  await check('dashboard summary', async () => {
    const r = await call(`/mandates/${DEMO_IDS.mandate}/summary`);
    return { ok: r.status === 200, detail: `HTTP ${r.status}` };
  });

  if (options.webOrigin !== undefined) {
    const origin = new URL(options.webOrigin).origin;
    await check('CORS for web origin', async () => {
      const r = await call(`/mandates/${DEMO_IDS.mandate}/purchases`, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
      });
      const allowed = r.headers.get('access-control-allow-origin');
      return { ok: allowed === origin, detail: allowed === origin ? `allows ${origin}` : `HTTP ${r.status}, origin not allowed (set WEB_ORIGIN)` };
    });
  }

  if (options.purchase) {
    await check('purchase request -> decision', async () => {
      const r = await call(`/mandates/${DEMO_IDS.mandate}/purchases`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requesterUserId: DEMO_IDS.requester, text: PURCHASE_TEXT, requestKey: `smoke-${randomUUID()}` }),
      });
      if (r.status === 404 && r.body?.['message'] === 'Route not found') {
        return { ok: false, detail: 'route missing: purchases disabled (see the API boot log for the missing variable names)' };
      }
      const status = str(r.body?.['status']);
      const outcome = str((r.body?.['decision'] as Record<string, unknown> | undefined)?.['outcome']);
      return {
        ok: (r.status === 201 || r.status === 200) && status !== '',
        detail: `HTTP ${r.status}, status ${status || '?'}, ${outcome ? `decision ${outcome}` : 'no decision'}, id ${str(r.body?.['id'], '?')}`,
      };
    });
  }
  return checks;
}

export function formatChecks(checks: readonly Check[]): string {
  const width = Math.max(...checks.map((c) => c.name.length));
  return checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(width)}  ${c.detail}`).join('\n');
}
