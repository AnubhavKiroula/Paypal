import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { ApiConfig } from './config.js';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { installProtection, type ProtectionOptions } from './http/protection.js';
import { healthRoutes, type ReadinessCheck } from './modules/health/routes.js';
import { mandateRoutes } from './modules/mandates/routes.js';
import type { MandateService } from './modules/mandates/service.js';
import { purchaseRoutes } from './modules/purchases/routes.js';
import type { PurchaseService } from './modules/purchases/service.js';
import { paypalWebhookRoutes, type PaypalWebhookHandler } from './modules/webhooks/paypal.js';

export interface AppOptions {
  config: Pick<ApiConfig, 'logLevel' | 'webOrigins'>;
  readinessChecks?: readonly ReadinessCheck[];
  /** Registered only when the database and every port (LLM, catalog, PayPal) are configured. */
  purchases?: PurchaseService;
  /** Mandate setup and dashboard reads. Registered when the database is configured. */
  mandates?: MandateService;
  /** Registered only when PAYPAL_WEBHOOK_ID is configured, so signatures can be verified. */
  paypalWebhooks?: PaypalWebhookHandler;
  /**
   * Builds the services with the app's own logger, for the server entry point. Its result is used when
   * `purchases` and `paypalWebhooks` are not passed directly.
   */
  compose?: (log: FastifyBaseLogger) => {
    purchases?: PurchaseService;
    paypalWebhooks?: PaypalWebhookHandler;
    mandates?: MandateService;
    countLlmRequestsToday?: () => Promise<number>;
  };
  /** Abuse protection (#62). Its countLlmRequestsToday falls back to the composed one. */
  protection?: ProtectionOptions & {
    /** TRUST_PROXY: addresses or CIDRs of the proxies in front of the API. Empty: X-Forwarded-For is ignored. */
    trustedProxies?: readonly string[];
  };
  /** Tests pass false to keep output quiet. */
  logger?: boolean;
}

function trustProxyList(proxies: readonly string[] | undefined): string | false {
  return proxies && proxies.length > 0 ? proxies.join(',') : false;
}

/** Request bodies are small JSON documents; anything larger is refused before it is parsed. */
export const BODY_LIMIT_BYTES = 64 * 1024;

/**
 * Builds the API without listening, so tests drive it with `app.inject`.
 * Modules (docs/architecture.md): intake, catalog, payments, approvals, audit, webhooks. Each registers its
 * routes here. Only `modules/payments` may import `@mandate/payments` (hard rule 1; see test/boundary.test.ts).
 */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: options.config.logLevel,
            // Credentials and webhook signatures must never reach the logs (hard rule 7).
            redact: {
              paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["paypal-transmission-sig"]'],
              censor: '[REDACTED]',
            },
          },
    bodyLimit: BODY_LIMIT_BYTES,
    // Trusted proxy addresses only, never `true`: with `true` the left-most X-Forwarded-For entry, which any client
    // can forge, would become request.ip. With a list, Fastify walks the header from the right and stops at the first
    // untrusted address. (A hop count is not an option: Fastify 5.12 ignores numeric trustProxy by design.)
    trustProxy: trustProxyList(options.protection?.trustedProxies),
    genReqId: () => randomUUID(),
    requestIdHeader: false,
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  app.addHook('onSend', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });

  const composed = options.compose?.(app.log) ?? {};
  const purchases = options.purchases ?? composed.purchases;
  const paypalWebhooks = options.paypalWebhooks ?? composed.paypalWebhooks;
  const mandates = options.mandates ?? composed.mandates;
  const countLlmRequestsToday = options.protection?.countLlmRequestsToday ?? composed.countLlmRequestsToday;

  // Only the configured web origins may call the API from a browser. No credentials: there are no cookies.
  if (options.config.webOrigins) {
    await app.register(cors, { origin: options.config.webOrigins, methods: ['GET', 'POST', 'PATCH'], credentials: false, maxAge: 600 });
  }
  // After CORS, so a 429 still carries the CORS headers and the browser can read it.
  const guard = installProtection(app, { ...options.protection, ...(countLlmRequestsToday ? { countLlmRequestsToday } : {}) });

  await app.register(healthRoutes(options.readinessChecks ?? []));
  if (purchases) await app.register(purchaseRoutes(purchases, guard));
  if (mandates) await app.register(mandateRoutes(mandates));
  if (paypalWebhooks) await app.register(paypalWebhookRoutes(paypalWebhooks));
  return app;
}
