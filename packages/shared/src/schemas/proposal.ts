import { z } from 'zod';
import { CandidateIdSchema, MAX_ITEMS, MAX_QUANTITY } from './ids.js';

/**
 * What the model may propose: candidate ids and quantities, never prices or totals (ADR 0004).
 * `reason` is model-written text: treat it as untrusted wherever it is displayed or re-used.
 */
export const ProposalSchema = z
  .strictObject({
    selections: z
      .array(
        z.strictObject({
          candidateId: CandidateIdSchema,
          quantity: z.int().min(1).max(MAX_QUANTITY),
          reason: z.string().min(1).max(300),
        }),
      )
      .max(MAX_ITEMS),
    unmatchedItems: z
      .array(
        z.strictObject({
          itemIndex: z.int().min(0).max(MAX_ITEMS - 1),
          reason: z.string().min(1).max(300),
        }),
      )
      .max(MAX_ITEMS),
  })
  .superRefine((proposal, ctx) => {
    const seen = new Set<string>();
    proposal.selections.forEach((selection, index) => {
      if (seen.has(selection.candidateId)) {
        ctx.addIssue({ code: 'custom', path: ['selections', index, 'candidateId'], message: 'Duplicate candidate' });
      }
      seen.add(selection.candidateId);
    });
  });

export type Proposal = z.infer<typeof ProposalSchema>;
