import { z } from 'zod';
import { MoneySchema } from '../money.js';
import { quarantineText } from '../quarantine.js';
import { CandidateIdSchema } from './ids.js';

/** Code-point limits for retailer-supplied text after quarantine. */
export const CANDIDATE_TEXT_LIMITS = { retailer: 100, title: 300, description: 2_000 } as const;

/** Raw input bound applied before quarantine runs, so its cost stays bounded. */
const MAX_RAW_TEXT = 100_000;

/** Untrusted retailer text: bounded, then quarantined. Parsing yields Quarantined<string>. */
const quarantined = (maxCodePoints: number) =>
  z
    .string()
    .max(MAX_RAW_TEXT)
    .transform((raw) => quarantineText(raw, { maxCodePoints }).text);

/**
 * A normalized catalog candidate. Built by code from catalog data, never parsed from model
 * output: it has transforms, so it deliberately cannot be exported as a model-facing JSON Schema.
 * Field mapping to PRODUCT_SNAPSHOT is listed in docs/llm-layer.md.
 */
export const CandidateSchema = z.strictObject({
  id: CandidateIdSchema,
  sourceProductId: z.string().regex(/^[!-~]{1,128}$/),
  retailer: quarantined(CANDIDATE_TEXT_LIMITS.retailer),
  unitPrice: MoneySchema,
  url: z.url({ protocol: /^https$/ }),
  fetchedAt: z.iso.datetime(),
  title: quarantined(CANDIDATE_TEXT_LIMITS.title),
  description: quarantined(CANDIDATE_TEXT_LIMITS.description),
});

export type CandidateInput = z.input<typeof CandidateSchema>;
export type Candidate = z.output<typeof CandidateSchema>;
