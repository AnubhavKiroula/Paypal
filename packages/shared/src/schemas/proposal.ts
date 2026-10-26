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
    const flagRepeats = <T>(values: readonly T[], path: [string, string], message: string) => {
      const seen = new Set<T>();
      values.forEach((value, index) => {
        if (seen.has(value)) ctx.addIssue({ code: 'custom', path: [path[0], index, path[1]], message });
        seen.add(value);
      });
    };
    flagRepeats(proposal.selections.map((s) => s.candidateId), ['selections', 'candidateId'], 'Duplicate candidate');
    flagRepeats(proposal.unmatchedItems.map((u) => u.itemIndex), ['unmatchedItems', 'itemIndex'], 'Duplicate item');
  });

export type Proposal = z.infer<typeof ProposalSchema>;
