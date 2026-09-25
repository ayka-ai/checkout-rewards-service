import { type DB, now, transaction } from '../db.ts';
import { errors } from '../errors.ts';
import { CURRENCY } from '../money.ts';

export interface ProductRow {
  id: string;
  name: string;
  price_minor: number;
  inventory: number;
  updated_at: string;
}

export function productView(p: ProductRow) {
  return {
    id: p.id,
    name: p.name,
    unitPriceMinor: p.price_minor,
    currency: CURRENCY,
    availableInventory: p.inventory,
  };
}

export function listProducts(db: DB) {
  const rows = db.prepare('SELECT * FROM products ORDER BY id').all() as unknown as ProductRow[];
  return rows.map(productView);
}

export function findProduct(db: DB, id: string): ProductRow | undefined {
  return db.prepare('SELECT * FROM products WHERE id = ?').get(id) as unknown as ProductRow | undefined;
}

export function getProduct(db: DB, id: string) {
  const p = findProduct(db, id);
  if (!p) throw errors.notFound('PRODUCT_NOT_FOUND', `Product ${id} does not exist.`);
  return productView(p);
}

/**
 * Admin: change a product's price and/or absolute inventory level.
 * Exists so evaluators can reproduce "price/availability changed after the
 * item was added to a cart". Past orders are unaffected because order lines
 * store their own snapshot.
 */
export function updateProduct(db: DB, id: string, patch: { priceMinor?: number; inventory?: number }) {
  return transaction(db, () => {
    const p = findProduct(db, id);
    if (!p) throw errors.notFound('PRODUCT_NOT_FOUND', `Product ${id} does not exist.`);
    const price = patch.priceMinor ?? p.price_minor;
    const inventory = patch.inventory ?? p.inventory;
    db.prepare('UPDATE products SET price_minor = ?, inventory = ?, updated_at = ? WHERE id = ?').run(
      price,
      inventory,
      now(),
      id,
    );
    return productView({ ...p, price_minor: price, inventory });
  });
}
