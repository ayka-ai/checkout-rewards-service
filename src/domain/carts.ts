import { randomUUID } from 'node:crypto';
import { type DB, now, transaction } from '../db.ts';
import { errors } from '../errors.ts';
import { CURRENCY, multiply, sum } from '../money.ts';
import { findProduct } from './products.ts';

export const MAX_LINE_QUANTITY = 1000;

interface CartRow {
  id: string;
  status: 'OPEN' | 'CHECKED_OUT';
  created_at: string;
  updated_at: string;
}

export interface CartLineRow {
  product_id: string;
  quantity: number;
  accepted_price_minor: number;
  name: string;
  price_minor: number;
  inventory: number;
}

export function findCart(db: DB, id: string): CartRow | undefined {
  return db.prepare('SELECT * FROM carts WHERE id = ?').get(id) as unknown as CartRow | undefined;
}

function requireCart(db: DB, id: string): CartRow {
  const cart = findCart(db, id);
  if (!cart) throw errors.notFound('CART_NOT_FOUND', `Cart ${id} does not exist.`);
  return cart;
}

function requireOpenCart(db: DB, id: string): CartRow {
  const cart = requireCart(db, id);
  if (cart.status !== 'OPEN') {
    const order = db.prepare('SELECT id FROM orders WHERE cart_id = ?').get(id) as { id: string } | undefined;
    throw errors.conflict('CART_NOT_OPEN', 'This cart has already been checked out and can no longer be changed.', {
      orderId: order?.id,
    });
  }
  return cart;
}

export function cartLines(db: DB, cartId: string): CartLineRow[] {
  return db
    .prepare(
      `SELECT ci.product_id, ci.quantity, ci.accepted_price_minor, p.name, p.price_minor, p.inventory
         FROM cart_items ci JOIN products p ON p.id = ci.product_id
        WHERE ci.cart_id = ?
        ORDER BY ci.product_id`,
    )
    .all(cartId) as unknown as CartLineRow[];
}

export function createCart(db: DB) {
  const id = randomUUID();
  const ts = now();
  db.prepare("INSERT INTO carts (id, status, created_at, updated_at) VALUES (?, 'OPEN', ?, ?)").run(id, ts, ts);
  return viewCart(db, id);
}

/**
 * The cart view is computed from *current* product data so the customer
 * always sees what checkout would charge right now, and any line whose price
 * moved since they accepted it, or that is now short on stock, is flagged.
 */
export function viewCart(db: DB, id: string) {
  const cart = requireCart(db, id);
  const lines = cartLines(db, id);
  const items = lines.map((l) => ({
    productId: l.product_id,
    name: l.name,
    quantity: l.quantity,
    unitPriceMinor: l.price_minor,
    acceptedUnitPriceMinor: l.accepted_price_minor,
    priceChanged: l.price_minor !== l.accepted_price_minor,
    lineTotalMinor: multiply(l.price_minor, l.quantity),
    availableInventory: l.inventory,
    inStock: l.inventory >= l.quantity,
  }));

  const issues: { code: string; productId: string; message: string }[] = [];
  for (const i of items) {
    if (i.priceChanged) {
      issues.push({
        code: 'PRICE_CHANGED',
        productId: i.productId,
        message: `Price changed from ${i.acceptedUnitPriceMinor} to ${i.unitPriceMinor}; set the quantity again to accept it.`,
      });
    }
    if (!i.inStock) {
      issues.push({
        code: 'INSUFFICIENT_INVENTORY',
        productId: i.productId,
        message: `Only ${i.availableInventory} available, ${i.quantity} in cart.`,
      });
    }
  }
  if (cart.status === 'OPEN' && items.length === 0) {
    issues.push({ code: 'CART_EMPTY', productId: '', message: 'Cart has no items.' });
  }

  const order =
    cart.status === 'CHECKED_OUT'
      ? (db.prepare('SELECT id FROM orders WHERE cart_id = ?').get(id) as { id: string } | undefined)
      : undefined;

  return {
    id: cart.id,
    status: cart.status,
    currency: CURRENCY,
    items,
    itemCount: items.reduce((n, i) => n + i.quantity, 0),
    subtotalMinor: sum(items.map((i) => i.lineTotalMinor)),
    readyForCheckout: cart.status === 'OPEN' && issues.length === 0,
    issues: cart.status === 'OPEN' ? issues : [],
    orderId: order?.id ?? null,
    createdAt: cart.created_at,
    updatedAt: cart.updated_at,
  };
}

export function parseQuantity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_LINE_QUANTITY) {
    throw errors.validation(`quantity must be an integer between 1 and ${MAX_LINE_QUANTITY}.`, {
      field: 'quantity',
      received: value ?? null,
    });
  }
  return value;
}

/**
 * Set the quantity of one product in the cart (creates the line if absent).
 * PUT-with-absolute-quantity is retry-safe: repeating it leaves the same cart,
 * whereas "add 1" would double-count on a retried request.
 *
 * Setting a line also records the current price as the price the customer
 * accepted, which is how a customer confirms a changed price.
 *
 * Inventory is checked here only to give early feedback; it is NOT reserved.
 * The authoritative check happens atomically at checkout.
 */
export function setCartItem(db: DB, cartId: string, productId: string, quantity: number) {
  return transaction(db, () => {
    requireOpenCart(db, cartId);
    const product = findProduct(db, productId);
    if (!product) throw errors.notFound('PRODUCT_NOT_FOUND', `Product ${productId} does not exist.`);
    if (quantity > product.inventory) {
      throw errors.conflict('INSUFFICIENT_INVENTORY', `Only ${product.inventory} of ${productId} available.`, {
        items: [{ productId, requested: quantity, available: product.inventory }],
      });
    }
    db.prepare(
      `INSERT INTO cart_items (cart_id, product_id, quantity, accepted_price_minor) VALUES (?, ?, ?, ?)
       ON CONFLICT (cart_id, product_id) DO UPDATE SET quantity = excluded.quantity,
                                                      accepted_price_minor = excluded.accepted_price_minor`,
    ).run(cartId, productId, quantity, product.price_minor);
    db.prepare('UPDATE carts SET updated_at = ? WHERE id = ?').run(now(), cartId);
    return viewCart(db, cartId);
  });
}

/**
 * Remove a line. Deliberately idempotent: removing a product that is not in
 * the cart (e.g. a retried DELETE whose first response was lost) succeeds and
 * returns the cart, instead of surfacing a confusing 404 to the retrying client.
 */
export function removeCartItem(db: DB, cartId: string, productId: string) {
  return transaction(db, () => {
    requireOpenCart(db, cartId);
    const result = db.prepare('DELETE FROM cart_items WHERE cart_id = ? AND product_id = ?').run(cartId, productId);
    if (result.changes > 0) db.prepare('UPDATE carts SET updated_at = ? WHERE id = ?').run(now(), cartId);
    return viewCart(db, cartId);
  });
}
