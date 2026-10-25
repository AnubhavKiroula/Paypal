import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PurchaseIntentSchema } from '../src/schemas/intent.js';
import { ProposalSchema } from '../src/schemas/proposal.js';

const item = { description: 'Name tags', quantity: 40 };
const intent = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: '1',
  items: [item],
  clarifications: [],
  needsClarification: false,
  ...overrides,
});
const selection = { candidateId: 'cand_ABCDEFGH', quantity: 40, reason: 'Matches the request' };
const proposal = (overrides: Record<string, unknown> = {}) => ({
  selections: [selection],
  unmatchedItems: [],
  ...overrides,
});

describe('PurchaseIntentSchema', () => {
  it('accepts several items with every optional field', () => {
    const value = intent({
      items: [
        { ...item, category: 'office_supplies', maxUnitPrice: { amountMinor: 250, currency: 'USD' }, neededBy: '2026-11-07' },
        { description: 'HDMI cable', quantity: 1 },
      ],
    });
    expect(PurchaseIntentSchema.parse(value)).toEqual(value);
  });

  it('accepts a clarification request with no items', () => {
    const value = intent({ items: [], clarifications: ['Which size?'], needsClarification: true });
    expect(PurchaseIntentSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ['quantity 0', intent({ items: [{ ...item, quantity: 0 }] })],
    ['a negative quantity', intent({ items: [{ ...item, quantity: -1 }] })],
    ['a float quantity', intent({ items: [{ ...item, quantity: 1.5 }] })],
    ['a NaN quantity', intent({ items: [{ ...item, quantity: Number.NaN }] })],
    ['a 1e21 quantity', intent({ items: [{ ...item, quantity: 1e21 }] })],
    ['a quantity above the sanity cap', intent({ items: [{ ...item, quantity: 10_001 }] })],
    ['a huge description', intent({ items: [{ ...item, description: 'x'.repeat(201) }] })],
    ['an empty description', intent({ items: [{ ...item, description: '' }] })],
    ['an extra item field', intent({ items: [{ ...item, unitPrice: 100 }] })],
    ['an extra top-level field', intent({ approved: true })],
    ['a float maxUnitPrice', intent({ items: [{ ...item, maxUnitPrice: { amountMinor: 2.5, currency: 'USD' } }] })],
    ['an invalid neededBy date', intent({ items: [{ ...item, neededBy: '2026-13-45' }] })],
    ['an unknown schemaVersion', intent({ schemaVersion: '2' })],
    ['21 items', intent({ items: Array.from({ length: 21 }, () => item) })],
    ['a huge clarification', intent({ clarifications: ['x'.repeat(301)], needsClarification: true })],
    ['needsClarification without a question', intent({ needsClarification: true })],
    ['no items and no clarification', intent({ items: [] })],
  ])('rejects %s', (_label, value) => {
    expect(PurchaseIntentSchema.safeParse(value).success).toBe(false);
  });
});

describe('ProposalSchema', () => {
  it('accepts selections and unmatched items', () => {
    const value = proposal({ unmatchedItems: [{ itemIndex: 1, reason: 'No HDMI cable under the cap' }] });
    expect(ProposalSchema.parse(value)).toEqual(value);
  });

  it('accepts an empty proposal', () => {
    expect(ProposalSchema.safeParse(proposal({ selections: [] })).success).toBe(true);
  });

  it.each([
    ['quantity 0', proposal({ selections: [{ ...selection, quantity: 0 }] })],
    ['a negative quantity', proposal({ selections: [{ ...selection, quantity: -3 }] })],
    ['a float quantity', proposal({ selections: [{ ...selection, quantity: 2.5 }] })],
    ['a NaN quantity', proposal({ selections: [{ ...selection, quantity: Number.NaN }] })],
    ['a 1e21 quantity', proposal({ selections: [{ ...selection, quantity: 1e21 }] })],
    ['a price field, which the model must never supply', proposal({ selections: [{ ...selection, unitPrice: 1 }] })],
    ['a total field', proposal({ total: { amountMinor: 1, currency: 'USD' } })],
    ['a candidate id that is not code-generated', proposal({ selections: [{ ...selection, candidateId: 'B07XYZ' }] })],
    ['a duplicate candidate', proposal({ selections: [selection, selection] })],
    ['a huge reason', proposal({ selections: [{ ...selection, reason: 'x'.repeat(301) }] })],
    ['an out-of-range itemIndex', proposal({ unmatchedItems: [{ itemIndex: 20, reason: 'none' }] })],
  ])('rejects %s', (_label, value) => {
    expect(ProposalSchema.safeParse(value).success).toBe(false);
  });
});

describe('JSON Schema export for model-facing schemas', () => {
  it.each([
    ['PurchaseIntentSchema', PurchaseIntentSchema],
    ['ProposalSchema', ProposalSchema],
  ])('%s is transform-free and forbids extra properties', (_label, schema) => {
    const json = z.toJSONSchema(schema, { unrepresentable: 'throw', io: 'output' });
    expect(json).toMatchObject({ type: 'object', additionalProperties: false });
  });
});
