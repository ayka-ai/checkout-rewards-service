import { type DB, readSnapshot } from '../db.ts';
import { CURRENCY } from '../money.ts';
import { milestoneStatus, type RewardRules } from './coupons.ts';

/**
 * Admin summary. Pure read inside one snapshot transaction, so all figures
 * describe the same instant and calling it never changes state.
 *
 * Every figure is derived from persisted orders/order_lines/coupons (not from
 * running counters), so it reconciles with GET /orders/:id by construction.
 */
export function buildReport(db: DB, rules: RewardRules) {
  return readSnapshot(db, () => {
    const products = db
      .prepare(
        `SELECT p.id AS productId, p.name AS name, COALESCE(SUM(ol.quantity), 0) AS quantitySold,
                COALESCE(SUM(ol.line_total_minor), 0) AS grossRevenueMinor
           FROM products p LEFT JOIN order_lines ol ON ol.product_id = p.id
          GROUP BY p.id ORDER BY p.id`,
      )
      .all() as { productId: string; name: string; quantitySold: number; grossRevenueMinor: number }[];

    const totals = db
      .prepare(
        `SELECT COUNT(*) AS orders,
                COALESCE(SUM(subtotal_minor), 0) AS gross,
                COALESCE(SUM(discount_minor), 0) AS discounts,
                COALESCE(SUM(total_minor), 0) AS net
           FROM orders`,
      )
      .get() as { orders: number; gross: number; discounts: number; net: number };

    const coupons = db
      .prepare(
        `SELECT COUNT(*) AS generated,
                COALESCE(SUM(CASE WHEN redeemed_order_id IS NULL THEN 1 ELSE 0 END), 0) AS available,
                COALESCE(SUM(CASE WHEN redeemed_order_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS redeemed
           FROM coupons`,
      )
      .get() as { generated: number; available: number; redeemed: number };

    return {
      currency: CURRENCY,
      totalOrders: totals.orders,
      products: products.map((p) => ({ ...p })),
      grossRevenueMinor: totals.gross,
      totalDiscountsMinor: totals.discounts,
      netRevenueMinor: totals.net,
      coupons: { ...coupons },
      rewards: { discountPercentForNewCoupons: rules.rewardDiscountPercent, ...milestoneStatus(db, rules) },
    };
  });
}
