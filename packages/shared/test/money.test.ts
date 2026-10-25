import { describe, expect, it } from 'vitest';
import { MoneyError, MoneySchema, addMoney, multiplyMoney } from '../src/money.js';

const usd = (amountMinor: number) => ({ amountMinor, currency: 'USD' });

describe('MoneySchema', () => {
  it.each([
    ['zero', usd(0)],
    ['largest safe integer', usd(Number.MAX_SAFE_INTEGER)],
  ])('accepts %s', (_label, value) => {
    expect(MoneySchema.parse(value)).toEqual(value);
  });

  it.each([
    ['a float amount', usd(10.5)],
    ['a negative amount', usd(-1)],
    ['NaN', usd(Number.NaN)],
    ['1e21', usd(1e21)],
    ['2^53, beyond safe integers', usd(2 ** 53)],
    ['Infinity', usd(Number.POSITIVE_INFINITY)],
    ['a numeric string', { amountMinor: '100', currency: 'USD' }],
    ['a lowercase currency', { amountMinor: 1, currency: 'usd' }],
    ['a two-letter currency', { amountMinor: 1, currency: 'US' }],
    ['an extra field', { amountMinor: 1, currency: 'USD', amount: 0.01 }],
  ])('rejects %s', (_label, value) => {
    expect(MoneySchema.safeParse(value).success).toBe(false);
  });
});

describe('addMoney', () => {
  it('adds amounts of the same currency exactly', () => {
    expect(addMoney(usd(1999), usd(1))).toEqual(usd(2000));
  });

  it('throws CURRENCY_MISMATCH instead of converting', () => {
    expect(() => addMoney(usd(1), { amountMinor: 1, currency: 'EUR' })).toThrowError(
      expect.objectContaining({ code: 'CURRENCY_MISMATCH' }) as Error,
    );
  });

  it('throws OVERFLOW when the sum passes the largest safe integer', () => {
    expect(() => addMoney(usd(Number.MAX_SAFE_INTEGER), usd(1))).toThrowError(MoneyError);
    expect(() => addMoney(usd(Number.MAX_SAFE_INTEGER), usd(1))).toThrowError(
      expect.objectContaining({ code: 'OVERFLOW' }) as Error,
    );
  });

  it('accepts a sum landing exactly on the largest safe integer', () => {
    expect(addMoney(usd(Number.MAX_SAFE_INTEGER - 1), usd(1))).toEqual(usd(Number.MAX_SAFE_INTEGER));
  });

  it('validates its inputs, so a float cannot enter the arithmetic', () => {
    expect(() => addMoney(usd(0.1), usd(0.2))).toThrow();
  });
});

describe('multiplyMoney', () => {
  it('multiplies by an integer quantity exactly', () => {
    expect(multiplyMoney(usd(250), 40)).toEqual(usd(10_000));
    expect(multiplyMoney(usd(250), 0)).toEqual(usd(0));
  });

  it.each([
    ['a fraction, which would need rounding', 1.5],
    ['a negative factor', -2],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a factor beyond safe integers', 2 ** 53],
  ])('throws INVALID_FACTOR for %s', (_label, factor) => {
    expect(() => multiplyMoney(usd(100), factor)).toThrowError(
      expect.objectContaining({ code: 'INVALID_FACTOR' }) as Error,
    );
  });

  it('throws OVERFLOW when the product passes the largest safe integer', () => {
    expect(() => multiplyMoney(usd(Number.MAX_SAFE_INTEGER), 2)).toThrowError(
      expect.objectContaining({ code: 'OVERFLOW' }) as Error,
    );
  });

  it('detects overflow that float multiplication would hide', () => {
    // 9007199254740993 is not representable as a double; BigInt arithmetic must still reject it.
    expect(() => multiplyMoney(usd(3_002_399_751_580_331), 3)).toThrowError(
      expect.objectContaining({ code: 'OVERFLOW' }) as Error,
    );
  });
});
