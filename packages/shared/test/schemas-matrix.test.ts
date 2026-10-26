import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type Money, MoneyError, addMoney, multiplyMoney } from '../src/money.js';
import { TRUNCATION_MARKER } from '../src/quarantine.js';
import { CANDIDATE_TEXT_LIMITS, CandidateSchema } from '../src/schemas/candidate.js';
import { CandidateIdSchema, MAX_ITEMS, MAX_QUANTITY } from '../src/schemas/ids.js';
import { PurchaseIntentSchema } from '../src/schemas/intent.js';
import { ProposalSchema } from '../src/schemas/proposal.js';

// Non-ASCII and control characters are built at runtime so this source stays ASCII-only.
const cp = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
const LF = cp(0x0a);
const EMOJI = cp(0x1f600);
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const RAW_TEXT_BOUND = 100_000;

const money = (amountMinor: number, currency = 'USD'): Money => ({ amountMinor, currency });
/** Feeds a malformed runtime value past the static types, as an untyped caller could. */
const asMoney = (value: unknown) => value as Money;
const asNumber = (value: unknown) => value as number;

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to throw');
}

function issuesOf(schema: z.ZodType, value: unknown) {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map(({ code, path, message }) => ({ code, path, message }));
}

describe('money arithmetic validates operands before computing', () => {
  const malformed: [string, unknown][] = [
    ['a lowercase currency', { amountMinor: 1, currency: 'usd' }],
    ['a currency with a trailing newline', { amountMinor: 1, currency: `USD${LF}` }],
    ['a fullwidth currency that NFKC would fold to USD', { amountMinor: 1, currency: cp(0xff35, 0xff33, 0xff24) }],
    ['a four-letter currency', { amountMinor: 1, currency: 'USDT' }],
    ['a numeric-string amount', { amountMinor: '100', currency: 'USD' }],
    ['a bigint amount', { amountMinor: 100n, currency: 'USD' }],
    ['an extra field', { amountMinor: 1, currency: 'USD', amount: 0.01 }],
    ['a missing currency', { amountMinor: 1 }],
    ['null', null],
  ];

  it.each(malformed)('addMoney rejects %s as either operand with a ZodError, not a MoneyError', (_label, bad) => {
    for (const call of [() => addMoney(asMoney(bad), money(1)), () => addMoney(money(1), asMoney(bad))]) {
      const error = thrownBy(call);
      expect(error).toBeInstanceOf(z.ZodError);
      expect(error).not.toBeInstanceOf(MoneyError);
    }
  });

  it.each(malformed)('multiplyMoney rejects %s with a ZodError even for a valid factor', (_label, bad) => {
    expect(thrownBy(() => multiplyMoney(asMoney(bad), 2))).toBeInstanceOf(z.ZodError);
  });

  it('validates a mismatched-currency operand before comparing currencies', () => {
    expect(thrownBy(() => addMoney(money(1), money(1.5, 'EUR')))).toBeInstanceOf(z.ZodError);
  });

  it.each([
    ['a numeric string', '3'],
    ['a bigint', 3n],
    ['null', null],
    ['undefined', undefined],
  ])('multiplyMoney rejects %s as a factor instead of coercing it', (_label, factor) => {
    expect(thrownBy(() => multiplyMoney(money(100), asNumber(factor)))).toMatchObject({ code: 'INVALID_FACTOR' });
  });
});

describe('MoneyError', () => {
  it('is an Error named MoneyError whose mismatch message keeps operand order', () => {
    const error = thrownBy(() => addMoney(money(1, 'USD'), money(1, 'EUR')));
    expect(error).toBeInstanceOf(MoneyError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'MoneyError', code: 'CURRENCY_MISMATCH', message: 'Cannot add USD to EUR' });
    expect(thrownBy(() => addMoney(money(1, 'EUR'), money(1, 'USD')))).toMatchObject({
      message: 'Cannot add EUR to USD',
    });
  });
});

describe('addMoney algebra on exact large values', () => {
  it.each([
    [0, 0, 0],
    [1_234_567_890_123_456, 7_654_321_098_765_432, 8_888_888_988_888_888],
    [2 ** 52, 2 ** 52 - 1, MAX_SAFE],
    [MAX_SAFE, 0, MAX_SAFE],
  ])('%i + %i = %i in either order', (a, b, sum) => {
    expect(addMoney(money(a, 'JPY'), money(b, 'JPY'))).toEqual(money(sum, 'JPY'));
    expect(addMoney(money(b, 'JPY'), money(a, 'JPY'))).toEqual(money(sum, 'JPY'));
  });

  it.each([
    [1, MAX_SAFE],
    [2 ** 52, 2 ** 52],
    [MAX_SAFE, MAX_SAFE],
  ])('%i + %i overflows in either order', (a, b) => {
    expect(thrownBy(() => addMoney(money(a), money(b)))).toMatchObject({ code: 'OVERFLOW' });
    expect(thrownBy(() => addMoney(money(b), money(a)))).toMatchObject({ code: 'OVERFLOW' });
  });

  it('is associative', () => {
    const a = money(2 ** 51, 'EUR');
    const b = money(2 ** 51 - 7, 'EUR');
    const c = money(12_345, 'EUR');
    expect(addMoney(addMoney(a, b), c)).toEqual(addMoney(a, addMoney(b, c)));
    expect(addMoney(addMoney(a, b), c)).toEqual(money(2 ** 52 + 12_338, 'EUR'));
  });

  it('never returns negative zero, even from negative-zero inputs the schema admits', () => {
    expect(Object.is(addMoney(money(-0), money(-0)).amountMinor, 0)).toBe(true);
    expect(Object.is(multiplyMoney(money(-0), 5).amountMinor, 0)).toBe(true);
    expect(Object.is(multiplyMoney(money(5), -0).amountMinor, 0)).toBe(true);
  });
});

describe('multiplyMoney identities and exact boundaries', () => {
  it.each([0, 1, 1_999, 2 ** 52, MAX_SAFE])('multiplying %i by 1 is the identity and returns a new object', (amount) => {
    const input = money(amount, 'EUR');
    const result = multiplyMoney(input, 1);
    expect(result).toEqual(money(amount, 'EUR'));
    expect(result).not.toBe(input);
  });

  it('accepts a product landing exactly on the largest safe integer and overflows one step past it', () => {
    // 2^53 - 1 = 6361 * 69431 * 20394401, and 6361 * 69431 = 441650591.
    expect(multiplyMoney(money(441_650_591), 20_394_401)).toEqual(money(MAX_SAFE));
    expect(thrownBy(() => multiplyMoney(money(441_650_591), 20_394_402))).toMatchObject({ code: 'OVERFLOW' });
  });

  it('accepts the largest safe factor when the amount is 0 or 1', () => {
    expect(multiplyMoney(money(1), MAX_SAFE)).toEqual(money(MAX_SAFE));
    expect(multiplyMoney(money(0), MAX_SAFE)).toEqual(money(0));
  });

  it('commutes amount and factor', () => {
    expect(multiplyMoney(money(250), 40)).toEqual(multiplyMoney(money(40), 250));
  });

  it.each([0, 1, 2, 3, 7])('multiplying by %i equals adding the amount that many times', (factor) => {
    const unit = money(1_999, 'GBP');
    let sum = money(0, 'GBP');
    for (let i = 0; i < factor; i += 1) sum = addMoney(sum, unit);
    expect(multiplyMoney(unit, factor)).toEqual(sum);
  });
});

const item = { description: 'Name tags', quantity: 40 };
const intent = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: '1',
  items: [item],
  clarifications: [],
  needsClarification: false,
  ...overrides,
});
const withItem = (fields: Record<string, unknown>) => intent({ items: [{ ...item, ...fields }] });
const questions = (count: number) => Array.from({ length: count }, () => 'Which size?');

describe('PurchaseIntentSchema boundaries', () => {
  it.each([
    ['a 1-character description', withItem({ description: 'x' })],
    ['a 200-character description', withItem({ description: 'x'.repeat(200) })],
    ['quantity 1', withItem({ quantity: 1 })],
    [`quantity ${MAX_QUANTITY}`, withItem({ quantity: MAX_QUANTITY })],
    ['a 1-character category', withItem({ category: 'x' })],
    ['a 64-character category', withItem({ category: 'x'.repeat(64) })],
    ['a zero maxUnitPrice', withItem({ maxUnitPrice: money(0) })],
    ['a maxUnitPrice at the largest safe integer', withItem({ maxUnitPrice: money(MAX_SAFE) })],
    ['a leap-day neededBy', withItem({ neededBy: '2028-02-29' })],
    [`${MAX_ITEMS} items`, intent({ items: Array.from({ length: MAX_ITEMS }, () => item) })],
    ['5 clarifications', intent({ clarifications: questions(5), needsClarification: true })],
    ['a 300-character clarification', intent({ clarifications: ['x'.repeat(300)], needsClarification: true })],
    ['items together with a clarification request', intent({ clarifications: questions(1), needsClarification: true })],
  ])('accepts %s', (_label, value) => {
    expect(PurchaseIntentSchema.parse(value)).toEqual(value);
  });

  it.each([
    ['an empty category', withItem({ category: '' })],
    ['a 65-character category', withItem({ category: 'x'.repeat(65) })],
    ['a numeric-string quantity', withItem({ quantity: '40' })],
    ['an item missing its quantity', intent({ items: [{ description: 'Name tags' }] })],
    ['an item missing its description', intent({ items: [{ quantity: 40 }] })],
    ['a null item', intent({ items: [null] })],
    ['a maxUnitPrice with a lowercase currency', withItem({ maxUnitPrice: { amountMinor: 250, currency: 'usd' } })],
    ['a maxUnitPrice with an extra field', withItem({ maxUnitPrice: { amountMinor: 250, currency: 'USD', label: '2.50' } })],
    ['a neededBy of 29 February in a common year', withItem({ neededBy: '2026-02-29' })],
    ['a neededBy of 31 April', withItem({ neededBy: '2026-04-31' })],
    ['a neededBy with a time component', withItem({ neededBy: '2026-11-07T00:00:00Z' })],
    ['an unpadded neededBy', withItem({ neededBy: '2026-1-7' })],
    ['6 clarifications', intent({ clarifications: questions(6), needsClarification: true })],
    ['an empty clarification', intent({ clarifications: [''], needsClarification: true })],
    ['a numeric schemaVersion', intent({ schemaVersion: 1 })],
    ['a string needsClarification', intent({ needsClarification: 'false' })],
    ['a missing clarifications array', { schemaVersion: '1', items: [item], needsClarification: false }],
    ['items given as an index-keyed object', intent({ items: { 0: item } })],
  ])('rejects %s', (_label, value) => {
    expect(PurchaseIntentSchema.safeParse(value).success).toBe(false);
  });
});

describe('PurchaseIntentSchema cross-field rules', () => {
  const noQuestion = { code: 'custom', path: ['clarifications'], message: 'Clarification requested without a question' };

  it('reports a clarification request without a question on the clarifications path', () => {
    expect(issuesOf(PurchaseIntentSchema, intent({ needsClarification: true }))).toEqual([noQuestion]);
  });

  it('does not also demand items when a clarification is requested', () => {
    expect(issuesOf(PurchaseIntentSchema, intent({ items: [], needsClarification: true }))).toEqual([noQuestion]);
  });

  it('requires items when no clarification is requested, even if questions are present', () => {
    expect(issuesOf(PurchaseIntentSchema, intent({ items: [], clarifications: questions(1) }))).toEqual([
      { code: 'custom', path: ['items'], message: 'No items and no clarification requested' },
    ]);
  });

  it('reports a field-level issue and the cross-field issue together in one parse', () => {
    const value = intent({ items: [{ ...item, quantity: 0 }], needsClarification: true });
    expect(issuesOf(PurchaseIntentSchema, value)).toEqual([
      expect.objectContaining({ code: 'too_small', path: ['items', 0, 'quantity'] }) as unknown,
      noQuestion,
    ]);
  });
});

const A = 'cand_AAAAAAAA';
const B = 'cand_BBBBBBBB';
const selection = (candidateId: string, overrides: Record<string, unknown> = {}) => ({
  candidateId,
  quantity: 1,
  reason: 'Matches the request',
  ...overrides,
});
const unmatched = (itemIndex: unknown, reason: unknown = 'No match under the cap') => ({ itemIndex, reason });
const proposal = (overrides: Record<string, unknown> = {}) => ({
  selections: [selection(A)],
  unmatchedItems: [],
  ...overrides,
});
const withSelection = (overrides: Record<string, unknown>) => proposal({ selections: [selection(A, overrides)] });
const withUnmatched = (itemIndex: unknown, reason?: unknown) =>
  proposal({ unmatchedItems: [unmatched(itemIndex, reason)] });
const distinctIds = (count: number) => Array.from({ length: count }, (_, i) => `cand_${String(i).padStart(8, '0')}`);

describe('ProposalSchema boundaries', () => {
  it.each([
    [`${MAX_ITEMS} distinct selections`, proposal({ selections: distinctIds(MAX_ITEMS).map((id) => selection(id)) })],
    [`${MAX_ITEMS} unmatched items`, proposal({ unmatchedItems: Array.from({ length: MAX_ITEMS }, (_, i) => unmatched(i)) })],
    ['selection quantity 1', withSelection({ quantity: 1 })],
    [`selection quantity ${MAX_QUANTITY}`, withSelection({ quantity: MAX_QUANTITY })],
    ['itemIndex 0', withUnmatched(0)],
    [`itemIndex ${MAX_ITEMS - 1}`, withUnmatched(MAX_ITEMS - 1)],
    ['a 1-character selection reason', withSelection({ reason: 'x' })],
    ['a 300-character selection reason', withSelection({ reason: 'x'.repeat(300) })],
    ['a 1-character unmatched reason', withUnmatched(0, 'x')],
    ['a 300-character unmatched reason', withUnmatched(0, 'x'.repeat(300))],
    ['candidate ids differing only by letter case', proposal({ selections: [selection('cand_ABCDEFGH'), selection('cand_abcdefgh')] })],
    ['only unmatched items', proposal({ selections: [], unmatchedItems: [unmatched(0)] })],
  ])('accepts %s', (_label, value) => {
    expect(ProposalSchema.parse(value)).toEqual(value);
  });

  it.each([
    [`${MAX_ITEMS + 1} distinct selections`, proposal({ selections: distinctIds(MAX_ITEMS + 1).map((id) => selection(id)) })],
    [
      `${MAX_ITEMS + 1} unmatched items with in-range indexes`,
      proposal({ unmatchedItems: Array.from({ length: MAX_ITEMS + 1 }, (_, i) => unmatched(i % MAX_ITEMS)) }),
    ],
    [`selection quantity ${MAX_QUANTITY + 1}`, withSelection({ quantity: MAX_QUANTITY + 1 })],
    ['a numeric-string selection quantity', withSelection({ quantity: '1' })],
    ['an empty selection reason', withSelection({ reason: '' })],
    ['a selection missing its reason', proposal({ selections: [{ candidateId: A, quantity: 1 }] })],
    ['itemIndex -1', withUnmatched(-1)],
    ['a fractional itemIndex', withUnmatched(0.5)],
    ['a numeric-string itemIndex', withUnmatched('0')],
    ['an empty unmatched reason', withUnmatched(0, '')],
    ['a 301-character unmatched reason', withUnmatched(0, 'x'.repeat(301))],
    ['an unmatched item carrying a candidateId', proposal({ unmatchedItems: [{ ...unmatched(0), candidateId: A }] })],
    ['a missing unmatchedItems array', { selections: [selection(A)] }],
    ['selections given as a single object', proposal({ selections: selection(A) })],
  ])('rejects %s', (_label, value) => {
    expect(ProposalSchema.safeParse(value).success).toBe(false);
  });
});

describe('ProposalSchema duplicate-candidate detection', () => {
  const duplicateAt = (index: number) => ({
    code: 'custom',
    path: ['selections', index, 'candidateId'],
    message: 'Duplicate candidate',
  });

  it.each([
    ['a non-adjacent repeat', [A, B, A], [2]],
    ['a triple', [A, A, A], [1, 2]],
    ['two interleaved pairs', [A, B, A, B], [2, 3]],
  ])('flags every later occurrence in %s', (_label, candidateIds, indexes) => {
    const value = proposal({ selections: candidateIds.map((id) => selection(id)) });
    expect(issuesOf(ProposalSchema, value)).toEqual(indexes.map((index) => duplicateAt(index)));
  });

  it('treats the same candidate with a different quantity and reason as a duplicate', () => {
    const value = proposal({ selections: [selection(A), selection(A, { quantity: 5, reason: 'Second pack' })] });
    expect(issuesOf(ProposalSchema, value)).toEqual([duplicateAt(1)]);
  });

  it(`flags ${MAX_ITEMS - 1} duplicates when all ${MAX_ITEMS} selections repeat one candidate`, () => {
    const value = proposal({ selections: Array.from({ length: MAX_ITEMS }, () => selection(A)) });
    expect(issuesOf(ProposalSchema, value)).toEqual(
      Array.from({ length: MAX_ITEMS - 1 }, (_, i) => duplicateAt(i + 1)),
    );
  });

  it('still detects a duplicate when another field of the same proposal is invalid', () => {
    const value = proposal({ selections: [selection(A, { quantity: 0 }), selection(A)] });
    expect(issuesOf(ProposalSchema, value)).toEqual([
      expect.objectContaining({ code: 'too_small', path: ['selections', 0, 'quantity'] }) as unknown,
      duplicateAt(1),
    ]);
  });
});

describe('ProposalSchema duplicate-item detection', () => {
  const duplicateItemAt = (index: number) => ({
    code: 'custom',
    path: ['unmatchedItems', index, 'itemIndex'],
    message: 'Duplicate item',
  });

  it('flags every later occurrence of the same itemIndex, whatever the reason', () => {
    const value = proposal({ unmatchedItems: [unmatched(0, 'a'), unmatched(1), unmatched(0, 'b'), unmatched(0)] });
    expect(issuesOf(ProposalSchema, value)).toEqual([duplicateItemAt(2), duplicateItemAt(3)]);
  });

  it('reports duplicate candidates and duplicate items together', () => {
    const value = proposal({ selections: [selection(A), selection(A)], unmatchedItems: [unmatched(3), unmatched(3)] });
    expect(issuesOf(ProposalSchema, value)).toEqual([
      { code: 'custom', path: ['selections', 1, 'candidateId'], message: 'Duplicate candidate' },
      duplicateItemAt(1),
    ]);
  });
});

const validCandidate = {
  id: 'cand_A1b2C3d4',
  sourceProductId: 'B07-XYZ_123',
  retailer: 'Acme Supplies',
  unitPrice: { amountMinor: 1299, currency: 'USD' },
  url: 'https://shop.example/item/1',
  fetchedAt: '2026-10-25T10:00:00Z',
  title: 'HDMI cable 2m',
  description: 'Braided.',
};
const candidateWith = (overrides: Record<string, unknown>) => ({ ...validCandidate, ...overrides });

describe('CandidateIdSchema', () => {
  const longest = `cand_${'Z9'.repeat(16)}`;
  const tooLong = `${longest}X`;

  it.each([
    ['8 alphanumerics', 'cand_A1b2C3d4'],
    ['32 alphanumerics', longest],
    ['digits only', 'cand_00000000'],
  ])('accepts %s', (_label, id) => {
    expect(CandidateIdSchema.parse(id)).toBe(id);
  });

  it.each([
    ['7 alphanumerics', 'cand_A1b2C3d'],
    ['33 alphanumerics', tooLong],
    ['the bare prefix', 'cand_'],
    ['an uppercase prefix', 'CAND_A1b2C3d4'],
    ['a hyphen separator', 'cand-A1b2C3d4'],
    ['an underscore in the body', 'cand_A1b2_C3d4'],
    ['a leading space', ' cand_A1b2C3d4'],
    ['a trailing newline', `cand_A1b2C3d4${LF}`],
    ['Arabic-Indic digits', `cand_${cp(0x0660).repeat(8)}`],
    ['fullwidth letters', `cand_${cp(0xff21).repeat(8)}`],
    ['a zero-width space in the body', `cand_A1b2${cp(0x200b)}C3d4`],
    ['a number', 12_345_678],
  ])('rejects %s', (_label, id) => {
    expect(CandidateIdSchema.safeParse(id).success).toBe(false);
  });

  it('is the id rule ProposalSchema and CandidateSchema both apply', () => {
    expect(ProposalSchema.safeParse(proposal({ selections: [selection(longest)] })).success).toBe(true);
    expect(CandidateSchema.safeParse(candidateWith({ id: longest })).success).toBe(true);
    expect(ProposalSchema.safeParse(proposal({ selections: [selection(tooLong)] })).success).toBe(false);
    expect(CandidateSchema.safeParse(candidateWith({ id: tooLong })).success).toBe(false);
  });
});

describe('CandidateSchema field rules', () => {
  it('passes plain values through unchanged', () => {
    expect(CandidateSchema.parse(validCandidate)).toEqual(validCandidate);
  });

  it.each(Object.keys(validCandidate))('requires %s', (key) => {
    const value = Object.fromEntries(Object.entries(validCandidate).filter(([name]) => name !== key));
    expect(CandidateSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    ['a sourceProductId at the low end of printable ASCII', candidateWith({ sourceProductId: '!' })],
    ['a sourceProductId at the high end of printable ASCII', candidateWith({ sourceProductId: '~' })],
    ['a 128-character sourceProductId', candidateWith({ sourceProductId: 'x'.repeat(128) })],
    ['an https url with port, query and fragment', candidateWith({ url: 'https://shop.example:8443/p?q=1#f' })],
    ['a punycode hostname', candidateWith({ url: 'https://xn--bcher-kva.example/' })],
    ['a fetchedAt with milliseconds', candidateWith({ fetchedAt: '2026-10-25T10:00:00.123Z' })],
    ['a zero unitPrice', candidateWith({ unitPrice: money(0) })],
    ['an empty description', candidateWith({ description: '' })],
  ])('accepts %s unchanged', (_label, value) => {
    expect(CandidateSchema.parse(value)).toEqual(value);
  });

  it.each([
    ['an empty sourceProductId', { sourceProductId: '' }],
    ['a 129-character sourceProductId', { sourceProductId: 'x'.repeat(129) }],
    ['a sourceProductId with a tab', { sourceProductId: `B07${cp(0x09)}XYZ` }],
    ['a sourceProductId with DEL', { sourceProductId: `B07${cp(0x7f)}` }],
    ['a sourceProductId with a no-break space', { sourceProductId: `B07${cp(0xa0)}XYZ` }],
    ['a sourceProductId with an accented letter', { sourceProductId: `B07${cp(0xe9)}` }],
    ['a sourceProductId with a trailing newline', { sourceProductId: `B07XYZ${LF}` }],
    ['an https url with no host', { url: 'https://' }],
    ['a scheme-relative url', { url: '//shop.example/item/1' }],
    ['a url with no scheme', { url: 'shop.example/item/1' }],
    ['an empty url', { url: '' }],
    ['a wss url', { url: 'wss://shop.example/socket' }],
    ['an https look-alike scheme', { url: 'httpss://shop.example/' }],
    ['an ftp url', { url: 'ftp://shop.example/item' }],
    ['a data url', { url: 'data:text/html,hi' }],
    ['a file url', { url: 'file:///etc/passwd' }],
    ['a url with a space in the host', { url: 'https://shop example/' }],
    ['a fetchedAt with a numeric offset', { fetchedAt: '2026-10-25T10:00:00+05:30' }],
    ['a fetchedAt without a zone', { fetchedAt: '2026-10-25T10:00:00' }],
    ['a fetchedAt without seconds', { fetchedAt: '2026-10-25T10:00Z' }],
    ['a fetchedAt with a space separator', { fetchedAt: '2026-10-25 10:00:00Z' }],
    ['a fetchedAt on 30 February', { fetchedAt: '2026-02-30T10:00:00Z' }],
    ['a fetchedAt at hour 24', { fetchedAt: '2026-10-25T24:00:00Z' }],
    ['a date-only fetchedAt', { fetchedAt: '2026-10-25' }],
    ['a numeric-string unitPrice amount', { unitPrice: { amountMinor: '1299', currency: 'USD' } }],
    ['a unitPrice with an extra field', { unitPrice: { amountMinor: 1299, currency: 'USD', tax: 0 } }],
    ['a number title, which quarantine alone would coerce', { title: 42 }],
    ['a null description', { description: null }],
    ['an array retailer', { retailer: ['Acme'] }],
    ['a url with a user part that hides the real host', { url: 'https://shop.example@evil.example/x' }],
    ['a url with a username and password', { url: 'https://user:pw@shop.example/' }],
    ['a url with only a password', { url: 'https://:pw@shop.example/' }],
    ['an empty title', { title: '' }],
    ['a whitespace-only title', { title: '   ' }],
    ['a title that quarantine empties', { title: cp(0x202e, 0x200b) }],
    ['an empty retailer', { retailer: '' }],
    ['a retailer that quarantine empties', { retailer: '<b></b>' }],
  ])('rejects %s', (_label, overrides) => {
    expect(CandidateSchema.safeParse(candidateWith(overrides)).success).toBe(false);
  });

  it.each([
    ['HTTPS://shop.example/item/1', 'https://shop.example/item/1'],
    ['https://SHOP.example', 'https://shop.example/'],
    ['https:shop.example', 'https://shop.example/'],
    ['https:/shop.example', 'https://shop.example/'],
  ])('stores %s in canonical form', (url, expected) => {
    expect(CandidateSchema.parse(candidateWith({ url })).url).toBe(expected);
  });

  it('reports credentials as a url issue with a fixed message', () => {
    const result = CandidateSchema.safeParse(candidateWith({ url: 'https://a@b.example/' }));
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ path: ['url'], message: 'URL must not contain credentials' }) as unknown,
    ]);
  });

  it('trims surrounding whitespace from the url', () => {
    const parsed = CandidateSchema.parse(candidateWith({ url: ' https://shop.example/item/1 ' }));
    expect(parsed.url).toBe('https://shop.example/item/1');
  });
});

type TextField = keyof typeof CANDIDATE_TEXT_LIMITS;
const TEXT_FIELDS: TextField[] = ['retailer', 'title', 'description'];
const parseText = (field: TextField, raw: string) => CandidateSchema.parse(candidateWith({ [field]: raw }))[field];

describe('CandidateSchema quarantines every retailer-supplied text field', () => {
  it.each(TEXT_FIELDS)('strips C0, DEL and C1 controls from %s', (field) => {
    const raw = `Acme${cp(0x07)}${cp(0x1b)}[31m Supplies${cp(0x7f)}${cp(0x85)}`;
    expect(parseText(field, raw)).toBe('Acme[31m Supplies');
  });

  it.each(TEXT_FIELDS)('strips bidi controls and zero-width characters from %s', (field) => {
    const raw = `${cp(0x2066)}Acme${cp(0x2069)} ${cp(0x061c)}Sup${cp(0x200b)}plies${cp(0x202a)}${cp(0xfeff)}`;
    expect(parseText(field, raw)).toBe('Acme Supplies');
  });

  it.each(TEXT_FIELDS)('strips an invisible tag-character payload from %s', (field) => {
    const raw = `Acme${cp(0xe0001, 0xe0042, 0xe0055, 0xe0059, 0xe007f)}`;
    expect(parseText(field, raw)).toBe('Acme');
  });

  it.each(TEXT_FIELDS)('neutralises a fullwidth angle bracket in %s after NFKC', (field) => {
    expect(parseText(field, `5 ${cp(0xff1c)} 6`)).toBe(`5 ${cp(0x2039)} 6`);
  });

  it.each(TEXT_FIELDS)('replaces a lone surrogate in %s with U+FFFD', (field) => {
    expect(parseText(field, `Acme${cp(0xd800)}`)).toBe(`Acme${cp(0xfffd)}`);
  });

  it.each(TEXT_FIELDS)('keeps %s of exactly its code-point limit intact', (field) => {
    const limit = CANDIDATE_TEXT_LIMITS[field];
    expect(parseText(field, 'x'.repeat(limit))).toBe('x'.repeat(limit));
    expect(parseText(field, EMOJI.repeat(limit))).toBe(EMOJI.repeat(limit));
  });

  it.each(TEXT_FIELDS)('truncates %s one code point past its limit, marker included in the limit', (field) => {
    const limit = CANDIDATE_TEXT_LIMITS[field];
    const kept = limit - TRUNCATION_MARKER.length;
    expect(parseText(field, 'x'.repeat(limit + 1))).toBe('x'.repeat(kept) + TRUNCATION_MARKER);
    expect(parseText(field, EMOJI.repeat(limit + 1))).toBe(EMOJI.repeat(kept) + TRUNCATION_MARKER);
  });

  it.each(TEXT_FIELDS)('accepts raw %s at the input bound and truncates it to the field limit', (field) => {
    const text = parseText(field, 'x'.repeat(RAW_TEXT_BOUND));
    expect([...text]).toHaveLength(CANDIDATE_TEXT_LIMITS[field]);
    expect(text.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it.each(['retailer', 'title'])('rejects raw %s one character over the input bound', (field) => {
    expect(CandidateSchema.safeParse(candidateWith({ [field]: 'x'.repeat(RAW_TEXT_BOUND + 1) })).success).toBe(false);
  });

  it('measures the raw input bound in code points, so astral characters count once', () => {
    expect(CandidateSchema.safeParse(candidateWith({ description: EMOJI.repeat(RAW_TEXT_BOUND) })).success).toBe(true);
    expect(CandidateSchema.safeParse(candidateWith({ description: EMOJI.repeat(RAW_TEXT_BOUND + 1) })).success).toBe(
      false,
    );
  });

  it('is idempotent: re-parsing a parsed candidate changes nothing, truncated text included', () => {
    const once = CandidateSchema.parse(
      candidateWith({
        retailer: `${cp(0x2066)}<b>Acme</b>${cp(0x2069)} ${'x'.repeat(200)}`,
        title: `Cable ${cp(0xff1c)} 2m${cp(0x200b)}`,
        description: `a${cp(0x0d, 0x0a, 0x0d, 0x0a, 0x0d, 0x0a, 0x0d, 0x0a)}b${cp(0x2028)}c`,
      }),
    );
    expect(once.description).toBe(`a${LF}${LF}b${LF}c`);
    expect(CandidateSchema.parse(once)).toEqual(once);
  });
});
