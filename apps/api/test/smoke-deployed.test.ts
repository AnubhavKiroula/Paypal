import { describe, expect, it } from 'vitest';
import { DEMO_IDS } from '../src/db/seed.js';
import { FIXTURE_PRODUCTS } from '../src/modules/catalog/fixture.js';
import { formatChecks, runSmoke, type FetchLike } from '../src/smoke/deployed.js';

const API = 'https://api.example.test';
const WEB = 'https://web.example.test';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

type Route = (init: RequestInit | undefined) => Response | Promise<Response>;

function fakeApi(overrides: Record<string, Route> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const routes: Record<string, Route> = {
    'GET /health': () => json(200, { status: 'ok' }),
    'GET /ready': () => json(200, { status: 'ready', checks: { postgres: 'ok' } }),
    [`GET /mandates/${DEMO_IDS.mandate}`]: () => json(200, { id: DEMO_IDS.mandate }),
    [`GET /mandates/${DEMO_IDS.mandate}/summary`]: () => json(200, {}),
    [`OPTIONS /mandates/${DEMO_IDS.mandate}/purchases`]: () => new Response(null, { status: 204, headers: { 'access-control-allow-origin': WEB } }),
    [`POST /mandates/${DEMO_IDS.mandate}/purchases`]: () => json(201, { id: 'p-1', status: 'PAYMENT_PENDING', decision: { outcome: 'ALLOW' } }),
    ...overrides,
  };
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, ...(init ? { init } : {}) });
    const route = routes[`${init?.method ?? 'GET'} ${new URL(url).pathname}`];
    if (!route) throw new Error(`unexpected ${url}`);
    return route(init);
  };
  return { fetch, calls };
}

describe('runSmoke', () => {
  it('passes every check against a healthy, seeded deployment, without submitting a purchase by default', async () => {
    const { fetch, calls } = fakeApi();
    const checks = await runSmoke({ apiUrl: `${API}/ignored/path`, webOrigin: `${WEB}/`, fetch });
    expect(checks.map((c) => [c.name, c.ok])).toEqual([
      ['health', true],
      ['ready (postgres)', true],
      ['demo mandate', true],
      ['dashboard summary', true],
      ['CORS for web origin', true],
    ]);
    expect(calls.every((c) => c.url.startsWith(`${API}/`))).toBe(true);
    expect(calls.some((c) => c.init?.method === 'POST')).toBe(false);
  });

  it('submits one purchase with --purchase and reports the decision', async () => {
    const { fetch, calls } = fakeApi();
    const checks = await runSmoke({ apiUrl: API, purchase: true, fetch });
    expect(checks.at(-1)).toEqual({ name: 'purchase request -> decision', ok: true, detail: 'HTTP 201, status PAYMENT_PENDING, decision ALLOW, id p-1' });
    const post = calls.find((c) => c.init?.method === 'POST');
    const body = JSON.parse(post?.init?.body as string) as Record<string, string>;
    expect(body).toMatchObject({ requesterUserId: DEMO_IDS.requester });
    expect(body['requestKey']).toMatch(/^smoke-[0-9a-f-]{36}$/);
  });

  it('asks for an office-supplies item the deployed fixture catalog sells, so the request can reach PayPal', async () => {
    const { fetch, calls } = fakeApi();
    await runSmoke({ apiUrl: API, purchase: true, fetch });
    const post = calls.find((c) => c.init?.method === 'POST');
    const text = (JSON.parse(post?.init?.body as string) as Record<string, string>)['text']?.toLowerCase() ?? '';
    // The product name before the comma ("Whiteboard markers" of "Whiteboard markers, 12 colours") must be in the text.
    const named = FIXTURE_PRODUCTS.filter(
      (p) => String(p.category).toLowerCase() === 'office supplies' && text.includes(String(p.title).split(',')[0]?.toLowerCase() ?? '\0'),
    );
    expect(named.map((p) => p.title)).not.toEqual([]);
  });

  it('names the likely cause when the demo data is missing, CORS is wrong or purchases are disabled', async () => {
    const { fetch } = fakeApi({
      [`GET /mandates/${DEMO_IDS.mandate}`]: () => json(404, { error: 'MANDATE_NOT_FOUND' }),
      [`GET /mandates/${DEMO_IDS.mandate}/summary`]: () => json(404, { error: 'MANDATE_NOT_FOUND' }),
      [`OPTIONS /mandates/${DEMO_IDS.mandate}/purchases`]: () => new Response(null, { status: 204 }),
      [`POST /mandates/${DEMO_IDS.mandate}/purchases`]: () => json(404, { error: 'NOT_FOUND', message: 'Route not found' }),
    });
    const checks = await runSmoke({ apiUrl: API, webOrigin: WEB, purchase: true, fetch });
    const failed = Object.fromEntries(checks.filter((c) => !c.ok).map((c) => [c.name, c.detail]));
    expect(failed).toEqual({
      'demo mandate': 'HTTP 404 MANDATE_NOT_FOUND (seeded?)',
      'dashboard summary': 'HTTP 404',
      'CORS for web origin': 'HTTP 204, origin not allowed (set WEB_ORIGIN)',
      'purchase request -> decision': 'route missing: purchases disabled (see the API boot log for the missing variable names)',
    });
  });

  it('reports a purchase that the API refused, with no decision', async () => {
    const { fetch } = fakeApi({ [`POST /mandates/${DEMO_IDS.mandate}/purchases`]: () => json(409, { error: 'REQUEST_KEY_CONFLICT' }) });
    const checks = await runSmoke({ apiUrl: API, purchase: true, fetch });
    expect(checks.at(-1)).toMatchObject({ ok: false, detail: 'HTTP 409, status ?, no decision, id ?' });
  });

  it('records a network failure or timeout as a failed check and carries on', async () => {
    const { fetch } = fakeApi({
      'GET /health': () => Promise.reject(new DOMException('timed out', 'TimeoutError')),
      'GET /ready': () => new Response('not json', { status: 503 }),
    });
    const checks = await runSmoke({ apiUrl: API, fetch });
    expect(checks.slice(0, 2)).toEqual([
      { name: 'health', ok: false, detail: 'TimeoutError' },
      { name: 'ready (postgres)', ok: false, detail: 'HTTP 503, postgres undefined' },
    ]);
    expect(checks).toHaveLength(4);
  });
});

describe('formatChecks', () => {
  it('prints one aligned PASS/FAIL line per check', () => {
    expect(formatChecks([{ name: 'health', ok: true, detail: 'HTTP 200' }, { name: 'ready (postgres)', ok: false, detail: 'HTTP 503' }])).toBe(
      'PASS  health            HTTP 200\nFAIL  ready (postgres)  HTTP 503',
    );
  });
});
