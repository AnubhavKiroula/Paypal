import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseRequest } from '../../http/errors.js';
import { type PurchaseGuard, refuse } from '../../http/protection.js';
import { PurchaseError, type PurchaseErrorCode, type PurchaseService } from './service.js';

const SubmitBodySchema = z.strictObject({
  // VERIFY/#10 follow-up: there is no authentication yet, so the requester is named in the body and only
  // checked against the mandate's organization. Real auth must replace this before anything public.
  requesterUserId: z.uuid(),
  text: z.string().trim().min(1).max(4000),
  requestKey: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
});

const MandateParamsSchema = z.strictObject({ mandateId: z.uuid() });
const PurchaseParamsSchema = z.strictObject({ purchaseId: z.uuid() });

const STATUS: Record<PurchaseErrorCode, number> = {
  NOT_FOUND: 404,
  MANDATE_NOT_FOUND: 404,
  REQUESTER_NOT_ALLOWED: 403,
  REQUEST_KEY_CONFLICT: 409,
  INVALID_STATE: 409,
  PAYMENT_NOT_CAPTURABLE: 409,
  APPROVAL_NOT_FOUND: 404,
  APPROVAL_ALREADY_DECIDED: 409,
  APPROVAL_EXPIRED: 410,
};

// The token travels in the body, never in a URL, so it does not end up in access logs or browser history.
const ApprovalDecisionSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  decision: z.enum(['APPROVE', 'REJECT']),
  channel: z.enum(['email', 'slack', 'dashboard', 'zapier']).default('zapier'),
});

const ApprovalPreviewSchema = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

function sendPurchaseError(error: unknown, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  if (!(error instanceof PurchaseError)) throw error;
  return reply.status(STATUS[error.code]).send({ error: error.code, message: 'Request rejected', requestId: request.id });
}

export function purchaseRoutes(service: PurchaseService, guard: PurchaseGuard) {
  /** The kill switch (PURCHASES_ENABLED=false) for every route that calls the LLM or moves money. */
  const switchedOff = (request: FastifyRequest, reply: FastifyReply): FastifyReply | undefined => {
    if (guard.purchasesEnabled) return undefined;
    guard.rejections.count('purchases_disabled');
    return refuse(request, reply, 'PURCHASES_DISABLED');
  };

  return (app: FastifyInstance): void => {
    app.post('/mandates/:mandateId/purchases', async (request, reply) => {
      const off = switchedOff(request, reply);
      if (off) return off;
      const { mandateId } = parseRequest(MandateParamsSchema, request.params);
      const body = parseRequest(SubmitBodySchema, request.body);
      // Intent parsing and ranking call the LLM: admit only within the concurrency limit and the daily cap.
      const entered = await guard.gate.enter();
      if (!entered.ok) {
        guard.rejections.count(entered.code.toLowerCase());
        return refuse(request, reply, entered.code, entered.retryAfterMs);
      }
      try {
        const { view, created } = await service.submit({ mandateId, ...body });
        return await reply.status(created ? 201 : 200).send(view);
      } catch (error) {
        return sendPurchaseError(error, request, reply);
      } finally {
        entered.release();
      }
    });

    app.get('/purchases/:purchaseId', async (request, reply) => {
      const { purchaseId } = parseRequest(PurchaseParamsSchema, request.params);
      try {
        return await reply.send(await service.get(purchaseId));
      } catch (error) {
        return sendPurchaseError(error, request, reply);
      }
    });

    app.post('/approvals/preview', async (request, reply) => {
      const { token } = parseRequest(ApprovalPreviewSchema, request.body);
      try {
        return await reply.send(await service.previewApproval(token));
      } catch (error) {
        return sendPurchaseError(error, request, reply);
      }
    });

    app.post('/approvals/decision', async (request, reply) => {
      // An approval pays for the order, so it is a payment route.
      const off = switchedOff(request, reply);
      if (off) return off;
      const body = parseRequest(ApprovalDecisionSchema, request.body);
      try {
        return await reply.send(await service.decideApproval(body.token, body.decision, body.channel));
      } catch (error) {
        return sendPurchaseError(error, request, reply);
      }
    });

    app.post('/purchases/:purchaseId/capture', async (request, reply) => {
      const off = switchedOff(request, reply);
      if (off) return off;
      const { purchaseId } = parseRequest(PurchaseParamsSchema, request.params);
      try {
        return await reply.send(await service.capture(purchaseId));
      } catch (error) {
        return sendPurchaseError(error, request, reply);
      }
    });
  };
}
