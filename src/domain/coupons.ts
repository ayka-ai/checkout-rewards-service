import { randomBytes } from 'node:crypto';
import { type DB, now, transaction } from '../db.ts';
import { errors } from '../errors.ts';

export interface CouponRow {
  code: string;
  milestone: number;
  every_n_orders: number;
  discount_percent: number;
  created_at: string;
  redeemed_order_id: string | null;
  redeemed_at: string | null;
}

export interface RewardRules {
  rewardEveryNOrders: number;
  rewardDiscountPercent: number;
}

export function normalizeCouponCode(code: string): string {
  return code.trim().toUpperCase();
}

export function findCoupon(db: DB, code: string): CouponRow | undefined {
  return db.prepare('SELECT * FROM coupons WHERE code = ?').get(code) as unknown as CouponRow | undefined;
}

export function couponView(c: CouponRow) {
  return {
    code: c.code,
    milestone: c.milestone,
    earnedAtOrderNumber: c.milestone * c.every_n_orders,
    discountPercent: c.discount_percent,
    status: c.redeemed_order_id ? ('REDEEMED' as const) : ('AVAILABLE' as const),
    redeemedByOrderId: c.redeemed_order_id,
    createdAt: c.created_at,
    redeemedAt: c.redeemed_at,
  };
}

// 10 chars of Crockford-ish base32 (no 0/O/1/I) ~ 50 bits: unguessable enough
// for a bearer code without making it painful to type.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function newCode(): string {
  const bytes = randomBytes(10);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return `SAVE-${s}`;
}

export function milestoneStatus(db: DB, rules: RewardRules) {
  const { placed } = db.prepare('SELECT COUNT(*) AS placed FROM orders').get() as { placed: number };
  const { last } = db.prepare('SELECT COALESCE(MAX(milestone), 0) AS last FROM coupons').get() as { last: number };
  const reached = Math.floor(placed / rules.rewardEveryNOrders);
  return {
    placedOrders: placed,
    everyNOrders: rules.rewardEveryNOrders,
    milestonesReached: reached,
    milestonesRewarded: last,
    unrewardedMilestones: Math.max(0, reached - last),
    nextMilestoneAtOrderNumber: (last + 1) * rules.rewardEveryNOrders,
  };
}

/**
 * Admin: generate the coupon for the oldest reached-but-unrewarded milestone.
 *
 * Milestones are numbered 1, 2, 3...; milestone k is reached once k*n orders
 * have been placed. At most one coupon ever exists per milestone, enforced by
 * the write lock here and by UNIQUE(coupons.milestone) in the schema, so two
 * admins clicking "generate" at the same time get one coupon and one 409.
 */
export function generateCoupon(db: DB, rules: RewardRules) {
  return transaction(db, () => {
    const status = milestoneStatus(db, rules);
    if (status.unrewardedMilestones === 0) {
      throw errors.conflict('NO_UNREWARDED_MILESTONE', 'No order milestone is waiting for a coupon.', status);
    }
    const milestone = status.milestonesRewarded + 1;
    const code = newCode();
    db.prepare(
      'INSERT INTO coupons (code, milestone, every_n_orders, discount_percent, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(code, milestone, rules.rewardEveryNOrders, rules.rewardDiscountPercent, now());
    return {
      coupon: couponView(findCoupon(db, code)!),
      remainingUnrewardedMilestones: status.unrewardedMilestones - 1,
    };
  });
}

export function listCoupons(db: DB) {
  const rows = db.prepare('SELECT * FROM coupons ORDER BY milestone').all() as unknown as CouponRow[];
  return rows.map(couponView);
}
