import { isIPv4 } from 'node:net';
import { z } from 'zod';

/** An IPv4 address with an optional prefix length, e.g. 10.0.0.0/8 or 192.168.1.4. */
function isCidrV4(value: string): boolean {
  const [address = '', prefix, ...rest] = value.split('/');
  return rest.length === 0 && isIPv4(address) && (prefix === undefined || (/^\d{1,2}$/.test(prefix) && Number(prefix) <= 32));
}

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const ApiEnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  // Loopback by default so a laptop never exposes the API by accident. Render sets HOST=0.0.0.0.
  HOST: z.string().min(1).default('127.0.0.1'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  // Optional until the routes that need Postgres land; the API starts without it. Contains a password.
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\/\S+$/).optional(),
  // Comma-separated browser origins allowed to call the API (the web app). Unset: no cross-origin access.
  WEB_ORIGIN: z
    .string()
    .transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean))
    .pipe(z.array(z.url({ protocol: /^https?$/ }).refine((url) => new URL(url).origin === url, 'Must be a bare origin')).min(1))
    .optional(),
  // Abuse protection (#62, docs/deploy.md). Kill switch for the LLM and payment routes; health and reads stay up.
  PURCHASES_ENABLED: z.enum(['true', 'false']).default('true'),
  // Comma-separated IPv4 addresses or CIDRs of the proxies in front of the API (Render: its private network).
  // Their X-Forwarded-For entries are trusted for the client IP; nothing is trusted when unset (local).
  TRUST_PROXY: z
    .string()
    .transform((value) => value.split(',').map((entry) => entry.trim()).filter(Boolean))
    .pipe(z.array(z.string().refine(isCidrV4)).max(20))
    .optional(),
  // Purchase requests per UTC day (each one calls the LLM), counted in Postgres.
  LLM_DAILY_REQUEST_CAP: z.coerce.number().int().min(0).max(100_000).default(100),
  // Of those, per client (IPv4, or IPv6 /64) per UTC day; in memory, so a restart resets it.
  LLM_DAILY_PER_IP_CAP: z.coerce.number().int().min(0).max(100_000).default(20),
  // Purchase requests calling the LLM at the same time.
  LLM_MAX_CONCURRENT: z.coerce.number().int().min(1).max(20).default(2),
  // Opt-in diagnostic to verify TRUST_PROXY on the deployed API: hop counts and a salted client hash, never raw IPs.
  DEBUG_PROXY_HOPS: z.enum(['true', 'false']).default('false'),
});

export interface ApiConfig {
  port: number;
  host: string;
  logLevel: (typeof LOG_LEVELS)[number];
  databaseUrl?: string;
  webOrigins?: string[];
  purchasesEnabled: boolean;
  trustedProxies: string[];
  llmDailyRequestCap: number;
  llmDailyPerIpCap: number;
  llmMaxConcurrent: number;
  debugProxyHops: boolean;
}

/** Names the invalid variables only. Values never appear in the message: some of them will be secrets. */
export class ApiConfigError extends Error {
  readonly variables: string[];

  constructor(variables: string[]) {
    super(`Invalid API configuration: ${variables.join(', ')}`);
    this.name = 'ApiConfigError';
    this.variables = variables;
  }
}

export function loadApiConfig(env: NodeJS.ProcessEnv): ApiConfig {
  // Empty strings count as unset, so `PORT=` in a .env falls back to the default instead of failing.
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ''));
  const result = ApiEnvSchema.safeParse(present);
  if (!result.success) {
    throw new ApiConfigError([...new Set(result.error.issues.map((issue) => String(issue.path[0])))]);
  }
  const { PORT, HOST, LOG_LEVEL, DATABASE_URL, WEB_ORIGIN, PURCHASES_ENABLED, TRUST_PROXY, LLM_DAILY_REQUEST_CAP, LLM_DAILY_PER_IP_CAP, LLM_MAX_CONCURRENT, DEBUG_PROXY_HOPS } = result.data;
  return {
    port: PORT,
    host: HOST,
    logLevel: LOG_LEVEL,
    purchasesEnabled: PURCHASES_ENABLED === 'true',
    trustedProxies: TRUST_PROXY ?? [],
    llmDailyRequestCap: LLM_DAILY_REQUEST_CAP,
    llmDailyPerIpCap: LLM_DAILY_PER_IP_CAP,
    llmMaxConcurrent: LLM_MAX_CONCURRENT,
    debugProxyHops: DEBUG_PROXY_HOPS === 'true',
    ...(DATABASE_URL === undefined ? {} : { databaseUrl: DATABASE_URL }),
    ...(WEB_ORIGIN === undefined ? {} : { webOrigins: WEB_ORIGIN }),
  };
}
