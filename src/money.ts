// Money is represented as an integer number of minor units (paise for INR).
// No floating-point value ever holds an amount. Every arithmetic result is
// checked to still be a safe integer so an overflow fails loudly instead of
// silently losing precision.

export const CURRENCY = 'INR';

export function assertMinor(value: number, label = 'amount'): number {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} is not a safe integer number of minor units: ${value}`);
  }
  return value;
}

export function multiply(unitMinor: number, quantity: number): number {
  return assertMinor(unitMinor * quantity, 'line total');
}

export function sum(values: number[]): number {
  return assertMinor(
    values.reduce((acc, v) => acc + v, 0),
    'sum',
  );
}

/**
 * Percentage discount on a non-negative amount, rounded half-up to the
 * nearest minor unit and capped at the amount itself, so the discounted
 * total can never be negative.
 *
 *   floor((amount * percent + 50) / 100)
 *
 * is exact integer arithmetic for non-negative integers (amount * percent
 * stays a safe integer for any realistic order total).
 */
export function percentDiscount(amountMinor: number, percent: number): number {
  assertMinor(amountMinor, 'subtotal');
  if (amountMinor < 0) throw new RangeError('subtotal must not be negative');
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new RangeError(`percent must be an integer between 0 and 100, got ${percent}`);
  }
  const scaled = assertMinor(amountMinor * percent, 'scaled amount');
  const discount = Math.floor((scaled + 50) / 100);
  return Math.min(discount, amountMinor);
}
