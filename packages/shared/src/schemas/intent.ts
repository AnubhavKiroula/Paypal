import { z } from 'zod';
import { MoneySchema } from '../money.js';
import { MAX_ITEMS, MAX_QUANTITY } from './ids.js';

export const INTENT_SCHEMA_VERSION = '1';

export const IntentItemSchema = z.strictObject({
  description: z.string().min(1).max(200),
  quantity: z.int().min(1).max(MAX_QUANTITY),
  category: z.string().min(1).max(64).optional(),
  maxUnitPrice: MoneySchema.optional(),
  neededBy: z.iso.date().optional(),
});

/** One request may hold several items, e.g. "40 name tags and an HDMI cable". */
export const PurchaseIntentSchema = z
  .strictObject({
    schemaVersion: z.literal(INTENT_SCHEMA_VERSION),
    items: z.array(IntentItemSchema).max(MAX_ITEMS),
    clarifications: z.array(z.string().min(1).max(300)).max(5),
    needsClarification: z.boolean(),
  })
  .superRefine((intent, ctx) => {
    if (intent.needsClarification && intent.clarifications.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['clarifications'], message: 'Clarification requested without a question' });
    }
    if (!intent.needsClarification && intent.items.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['items'], message: 'No items and no clarification requested' });
    }
  });

export type IntentItem = z.infer<typeof IntentItemSchema>;
export type PurchaseIntent = z.infer<typeof PurchaseIntentSchema>;
