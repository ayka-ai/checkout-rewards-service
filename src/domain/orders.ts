import { randomUUID } from 'node:crypto';
import { type DB, now, transaction } from '../db.ts';
import { errors } from '../errors.ts';
import { CURRENCY, multiply, percentDiscount, sum } from '../money.ts';
import { cartLines, findCart } from './carts.ts';
import { findCoupon, normalizeCouponCode } from './coupons.ts';

interface OrderRow {
  id: string;
  order_number: number;
  cart_id: string;
  subtotal_minor: number;
  discount_minor: number;
  total_minor: number;
  coupon_code: string | null;
  discount_percent: number | null;
  currency: string;
  created_at: string;
}

interface OrderLineRow {
  product_id: string;
  product_name: string;
  unit_price_minor: number;
  quantity: number;
  line_total_minor: number;
}

export interface CheckoutRequest {
  cartId: string;
  idempotencyKey: string;
  couponCode?: string | null;
}

export interface CheckoutResult {
  order: ReturnType<typeof orderView>;
  /** true when this response replays an order created by an earlier request with the same key. */
  replayed: boolean;
}

function orderView(order: OrderRow, lines: OrderLineRow[]) {
  return {
    id: order.id,
    orderNumber: order.order_number,
    cartId: order.cart_id,
    status: 'PLACED' as const,
    currency: order.currency,
    lines: lines.map((l) => ({
      productId: l.product_id,
      productName: l.product_name,
      unitPriceMinor: l.unit_price_minor,
      quantity: l.quantity,
      lineTotalMinor: l.line_total_minor,
    })),
    subtotalMinor: order.subtotal_minor,
    discount:
      order.coupon_code === null
        ? null
        : {
            couponCode: order.coupon_code,
            percent: order.discount_percent,
            amountMinor: order.discount_minor,
            rule: 'round(subtotal * percent / 100) half-up to the nearest paisa, capped at subtotal',
          },
    discountMinor: order.discount_minor,
    totalMinor: order.total_minor,
    createdAt: order.created_at,
  };
}

function loadOrder(db: DB, id: string) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as unknown as OrderRow | undefined;
  if (!order) return undefined;
  const lines = db
    .prepare('SELECT * FROM order_lines WHERE order_id = ? ORDER BY product_id')
    .all(id) as unknown as OrderLineRow[];
  return orderView(order, lines);
}

export function getOrder(db: DB, id: string) {
  const order = loadOrder(db, id);
  if (!order) throw errors.notFound('ORDER_NOT_FOUND', `Order ${id} does not exist.`);
  return order;
}

/**
 * Checkout = one write transaction. Either everything below commits together
 * (order, lines, inventory decrements, coupon redemption, cart state,
 * idempotency record) or nothing does. A failure anywhere rolls back the
 * coupon claim, so a failed checkout can never consume a coupon.
 *
 * Every state change is additionally written as a *guarded* statement
 * (`... WHERE inventory >= ?`, `... WHERE redeemed_order_id IS NULL`,
 * `... WHERE status = 'OPEN'`) and checked for exactly one affected row, and the
 * schema carries UNIQUE/CHECK constraints for the same rules. Those guards do
 * not rely on SQLite's single-writer lock, so the logic stays correct if it is
 * ported to a database with row-level concurrency.
 */
export function checkout(db: DB, req: CheckoutRequest): CheckoutResult {
  const couponCode = req.couponCode ? normalizeCouponCode(req.couponCode) : null;

  return transaction(db, () => {
    // 1. Idempotent replay: the same key always maps to the same order.
    const prior = db.prepare('SELECT * FROM idempotency_keys WHERE key = ?').get(req.idempotencyKey) as
      | { cart_id: string; coupon_code: string | null; order_id: string }
      | undefined;
    if (prior) {
      if (prior.cart_id !== req.cartId || prior.coupon_code !== couponCode) {
        throw errors.unprocessable(
          'IDEMPOTENCY_KEY_REUSED',
          'This Idempotency-Key was already used for a different checkout request. Use a new key.',
          { orderId: prior.order_id },
        );
      }
      return { order: loadOrder(db, prior.order_id)!, replayed: true };
    }

    // 2. Cart must exist, be open, and be non-empty.
    const cart = findCart(db, req.cartId);
    if (!cart) throw errors.notFound('CART_NOT_FOUND', `Cart ${req.cartId} does not exist.`);
    if (cart.status !== 'OPEN') {
      const existing = db.prepare('SELECT id FROM orders WHERE cart_id = ?').get(req.cartId) as { id: string };
      throw errors.conflict('CART_ALREADY_CHECKED_OUT', 'This cart has already been checked out.', {
        orderId: existing.id,
      });
    }
    const lines = cartLines(db, req.cartId);
    if (lines.length === 0) throw errors.unprocessable('CART_EMPTY', 'Cannot check out an empty cart.');

    // 3. Never charge a price the customer has not accepted.
    const repriced = lines.filter((l) => l.price_minor !== l.accepted_price_minor);
    if (repriced.length > 0) {
      throw errors.conflict('PRICE_CHANGED', 'Some prices changed since they were added. Review the cart and confirm.', {
        items: repriced.map((l) => ({
          productId: l.product_id,
          acceptedUnitPriceMinor: l.accepted_price_minor,
          currentUnitPriceMinor: l.price_minor,
        })),
      });
    }

    // 4. Stock check across all lines so the client learns every shortfall at once.
    const short = lines.filter((l) => l.inventory < l.quantity);
    if (short.length > 0) {
      throw errors.conflict('INSUFFICIENT_INVENTORY', 'Not enough stock for some items.', {
        items: short.map((l) => ({ productId: l.product_id, requested: l.quantity, available: l.inventory })),
      });
    }

    // 5. Price the order from the current (== accepted) prices.
    const pricedLines = lines.map((l) => ({ ...l, lineTotal: multiply(l.price_minor, l.quantity) }));
    const subtotal = sum(pricedLines.map((l) => l.lineTotal));

    // 6. Coupon: must exist and be unredeemed. Its percent was fixed at generation time.
    let discount = 0;
    let discountPercent: number | null = null;
    if (couponCode) {
      const coupon = findCoupon(db, couponCode);
      if (!coupon) throw errors.unprocessable('COUPON_NOT_FOUND', `Coupon ${couponCode} does not exist.`);
      if (coupon.redeemed_order_id) {
        throw errors.conflict('COUPON_ALREADY_REDEEMED', `Coupon ${couponCode} has already been redeemed.`);
      }
      discountPercent = coupon.discount_percent;
      discount = percentDiscount(subtotal, coupon.discount_percent);
    }
    const total = subtotal - discount;

    // 7. Write the order with an immutable snapshot of what was bought and why it cost what it did.
    const orderId = randomUUID();
    const createdAt = now();
    const { next } = db.prepare('SELECT COALESCE(MAX(order_number), 0) + 1 AS next FROM orders').get() as {
      next: number;
    };
    db.prepare(
      `INSERT INTO orders (id, order_number, cart_id, subtotal_minor, discount_minor, total_minor,
                           coupon_code, discount_percent, currency, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(orderId, next, req.cartId, subtotal, discount, total, couponCode, discountPercent, CURRENCY, createdAt);

    const insertLine = db.prepare(
      `INSERT INTO order_lines (order_id, product_id, product_name, unit_price_minor, quantity, line_total_minor)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const decrement = db.prepare(
      'UPDATE products SET inventory = inventory - ?, updated_at = ? WHERE id = ? AND inventory >= ?',
    );
    for (const l of pricedLines) {
      insertLine.run(orderId, l.product_id, l.name, l.price_minor, l.quantity, l.lineTotal);
      if (decrement.run(l.quantity, createdAt, l.product_id, l.quantity).changes !== 1) {
        throw errors.conflict('INSUFFICIENT_INVENTORY', 'Not enough stock for some items.', {
          items: [{ productId: l.product_id, requested: l.quantity }],
        });
      }
    }

    // 8. Claim the coupon. The WHERE clause makes this a compare-and-set.
    if (couponCode) {
      const claimed = db
        .prepare('UPDATE coupons SET redeemed_order_id = ?, redeemed_at = ? WHERE code = ? AND redeemed_order_id IS NULL')
        .run(orderId, createdAt, couponCode);
      if (claimed.changes !== 1) {
        throw errors.conflict('COUPON_ALREADY_REDEEMED', `Coupon ${couponCode} has already been redeemed.`);
      }
    }

    // 9. Close the cart (compare-and-set on status) and record the idempotency key.
    const closed = db
      .prepare("UPDATE carts SET status = 'CHECKED_OUT', updated_at = ? WHERE id = ? AND status = 'OPEN'")
      .run(createdAt, req.cartId);
    if (closed.changes !== 1) {
      throw errors.conflict('CART_ALREADY_CHECKED_OUT', 'This cart has already been checked out.');
    }
    db.prepare(
      'INSERT INTO idempotency_keys (key, cart_id, coupon_code, order_id, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(req.idempotencyKey, req.cartId, couponCode, orderId, createdAt);

    return { order: loadOrder(db, orderId)!, replayed: false };
  });
}
