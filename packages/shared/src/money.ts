import { z } from 'zod';

/** ISO 4217 alpha-3 format. Membership in the ISO list is not checked here. */
export const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);

/** Money is an integer count of minor units plus a currency. Never a float. */
export const MoneySchema = z.strictObject({
  amountMinor: z.int().nonnegative(),
  currency: CurrencySchema,
});

export type Money = z.infer<typeof MoneySchema>;

export type MoneyErrorCode = 'CURRENCY_MISMATCH' | 'OVERFLOW' | 'INVALID_FACTOR';

export class MoneyError extends Error {
  readonly code: MoneyErrorCode;

  constructor(code: MoneyErrorCode, message: string) {
    super(message);
    this.name = 'MoneyError';
    this.code = code;
  }
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

// Arithmetic runs in BigInt so an intermediate result can never lose precision.
function toSafeAmount(value: bigint): number {
  if (value > MAX_SAFE) {
    throw new MoneyError('OVERFLOW', 'Amount exceeds the largest safe integer');
  }
  return Number(value);
}

export function addMoney(a: Money, b: Money): Money {
  const left = MoneySchema.parse(a);
  const right = MoneySchema.parse(b);
  if (left.currency !== right.currency) {
    throw new MoneyError('CURRENCY_MISMATCH', `Cannot add ${left.currency} to ${right.currency}`);
  }
  return {
    amountMinor: toSafeAmount(BigInt(left.amountMinor) + BigInt(right.amountMinor)),
    currency: left.currency,
  };
}

/** Multiplies by an integer factor such as a quantity. Fractions are rejected: minor units cannot be rounded. */
export function multiplyMoney(money: Money, factor: number): Money {
  const parsed = MoneySchema.parse(money);
  if (!Number.isSafeInteger(factor) || factor < 0) {
    throw new MoneyError('INVALID_FACTOR', 'Factor must be a non-negative safe integer');
  }
  return {
    amountMinor: toSafeAmount(BigInt(parsed.amountMinor) * BigInt(factor)),
    currency: parsed.currency,
  };
}
