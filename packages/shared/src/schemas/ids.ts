import { z } from 'zod';

/** Opaque, code-generated candidate id. The model sees these, never database ids or prices. */
export const CandidateIdSchema = z.string().regex(/^cand_[A-Za-z0-9]{8,32}$/);

/** Shared sanity cap for quantities. Not a plausibility limit: that is a policy reason. */
export const MAX_QUANTITY = 10_000;

/** Upper bound on items in one request, and therefore on selections per proposal. */
export const MAX_ITEMS = 20;
