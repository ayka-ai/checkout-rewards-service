import { test } from 'node:test';
import assert from 'node:assert/strict';
import { multiply, percentDiscount, sum } from '../src/money.ts';

test('percent discount rounds half-up to the nearest paisa', () => {
  assert.equal(percentDiscount(3333, 10), 333); // 333.3  -> 333
  assert.equal(percentDiscount(3335, 10), 334); // 333.5  -> 334 (half-up)
  assert.equal(percentDiscount(5, 10), 1); //       0.5    -> 1
  assert.equal(percentDiscount(4, 10), 0); //       0.4    -> 0
  assert.equal(percentDiscount(29_950 * 3, 15), 13_478); // 13477.5 -> 13478
});

test('discount never exceeds the amount, so totals can never go negative', () => {
  assert.equal(percentDiscount(12_345, 100), 12_345);
  assert.equal(percentDiscount(0, 50), 0);
  for (const amount of [0, 1, 7, 99, 101, 3333, 1_000_000_007]) {
    for (const pct of [1, 10, 33, 50, 99, 100]) {
      const d = percentDiscount(amount, pct);
      assert.ok(Number.isInteger(d) && d >= 0 && d <= amount, `${amount} @ ${pct}% -> ${d}`);
    }
  }
});

test('the classic float trap does not happen: 0.1 + 0.2 style sums are exact', () => {
  // 10 + 20 paise, 3 x Rs 33.33 -- would drift as floats, exact as integers.
  assert.equal(sum([10, 20]), 30);
  assert.equal(multiply(3333, 3), 9999);
});

test('money helpers reject non-integer and unsafe values instead of silently rounding', () => {
  assert.throws(() => percentDiscount(10.5, 10), RangeError);
  assert.throws(() => percentDiscount(100, 10.5), RangeError);
  assert.throws(() => percentDiscount(-1, 10), RangeError);
  assert.throws(() => multiply(Number.MAX_SAFE_INTEGER, 2), RangeError);
});
