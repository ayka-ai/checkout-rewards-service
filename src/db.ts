import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from './errors.ts';

export type DB = DatabaseSync;

// The schema is the last line of defence for every invariant. The service code
// checks the same rules first so it can return precise errors, but even a buggy
// code path cannot commit a row that violates these constraints.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  price_minor  INTEGER NOT NULL CHECK (price_minor > 0),
  inventory    INTEGER NOT NULL CHECK (inventory >= 0),          -- never oversell
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS carts (
  id          TEXT PRIMARY KEY,
  status      TEXT NOT NULL CHECK (status IN ('OPEN', 'CHECKED_OUT')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cart_items (
  cart_id                 TEXT NOT NULL REFERENCES carts(id),
  product_id              TEXT NOT NULL REFERENCES products(id),
  quantity                INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  -- Price the customer last saw/accepted for this line. Checkout refuses to
  -- charge a different price until the customer re-confirms the line.
  accepted_price_minor    INTEGER NOT NULL CHECK (accepted_price_minor > 0),
  PRIMARY KEY (cart_id, product_id)
);

CREATE TABLE IF NOT EXISTS coupons (
  code               TEXT PRIMARY KEY,
  milestone          INTEGER NOT NULL UNIQUE CHECK (milestone >= 1),   -- one coupon per milestone
  every_n_orders     INTEGER NOT NULL CHECK (every_n_orders >= 1),
  discount_percent   INTEGER NOT NULL CHECK (discount_percent BETWEEN 1 AND 100),
  created_at         TEXT NOT NULL,
  redeemed_order_id  TEXT UNIQUE REFERENCES orders(id),                -- redeemed at most once
  redeemed_at        TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id                TEXT PRIMARY KEY,
  order_number      INTEGER NOT NULL UNIQUE CHECK (order_number >= 1),
  cart_id           TEXT NOT NULL UNIQUE REFERENCES carts(id),        -- a cart becomes at most one order
  subtotal_minor    INTEGER NOT NULL CHECK (subtotal_minor >= 0),
  discount_minor    INTEGER NOT NULL CHECK (discount_minor >= 0 AND discount_minor <= subtotal_minor),
  total_minor       INTEGER NOT NULL CHECK (total_minor >= 0),
  coupon_code       TEXT UNIQUE REFERENCES coupons(code),             -- a coupon discounts at most one order
  discount_percent  INTEGER CHECK (discount_percent BETWEEN 1 AND 100),
  currency          TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  CHECK (total_minor = subtotal_minor - discount_minor),
  CHECK ((coupon_code IS NULL) = (discount_percent IS NULL))
);

CREATE TABLE IF NOT EXISTS order_lines (
  order_id          TEXT NOT NULL REFERENCES orders(id),
  product_id        TEXT NOT NULL,
  product_name      TEXT NOT NULL,          -- snapshot: survives later product edits
  unit_price_minor  INTEGER NOT NULL CHECK (unit_price_minor > 0),
  quantity          INTEGER NOT NULL CHECK (quantity >= 1),
  line_total_minor  INTEGER NOT NULL,
  CHECK (line_total_minor = unit_price_minor * quantity),
  PRIMARY KEY (order_id, product_id)
);

-- Only successful checkouts are recorded. The row is written in the same
-- transaction as the order, so "key recorded" <=> "order exists".
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          TEXT PRIMARY KEY,
  cart_id      TEXT NOT NULL,
  coupon_code  TEXT,
  order_id     TEXT NOT NULL UNIQUE REFERENCES orders(id),
  created_at   TEXT NOT NULL
);
`;

export const SEED_PRODUCTS = [
  { id: 'p_tshirt', name: 'Cotton T-Shirt', priceMinor: 49_900, inventory: 100 },
  { id: 'p_mug', name: 'Ceramic Mug', priceMinor: 29_950, inventory: 50 },
  { id: 'p_headphones', name: 'Wireless Headphones', priceMinor: 249_900, inventory: 20 },
  { id: 'p_notebook', name: 'A5 Notebook', priceMinor: 12_500, inventory: 200 },
  { id: 'p_stickers', name: 'Sticker Pack', priceMinor: 3_333, inventory: 500 },
  { id: 'p_sneakers_ltd', name: 'Limited Edition Sneakers', priceMinor: 899_900, inventory: 3 },
];

export function openDatabase(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000'); // wait for another process's write lock instead of failing immediately
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  seed(db);
  return db;
}

function seed(db: DB): void {
  transaction(db, () => {
    const count = (db.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number }).n;
    if (count > 0) return;
    const insert = db.prepare(
      'INSERT INTO products (id, name, price_minor, inventory, updated_at) VALUES (?, ?, ?, ?, ?)',
    );
    const now = new Date().toISOString();
    for (const p of SEED_PRODUCTS) insert.run(p.id, p.name, p.priceMinor, p.inventory, now);
  });
}

function isBusy(err: unknown): boolean {
  const e = err as { errcode?: number; message?: string };
  // SQLITE_BUSY = 5, SQLITE_LOCKED = 6 (extended codes keep the low byte)
  return (e?.errcode !== undefined && [5, 6].includes(e.errcode & 0xff)) || /database is locked/i.test(e?.message ?? '');
}

/**
 * Run `fn` inside a write transaction.
 *
 * BEGIN IMMEDIATE takes SQLite's single write lock *before* any reads, so the
 * read-validate-write sequence in `fn` cannot interleave with another writer,
 * including one in a different process sharing the same database file.
 * `fn` is synchronous, so nothing else in this process can run in the middle.
 * Any throw rolls back every write in the transaction.
 */
export function transaction<T>(db: DB, fn: () => T): T {
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (err) {
    if (isBusy(err)) {
      throw new AppError(503, 'SERVICE_BUSY', 'The store is busy, please retry.', undefined, true);
    }
    throw err;
  }
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    if (isBusy(err)) {
      throw new AppError(503, 'SERVICE_BUSY', 'The store is busy, please retry.', undefined, true);
    }
    throw err;
  }
}

/** Read-only transaction: every query in `fn` sees one consistent snapshot. */
export function readSnapshot<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN');
  try {
    return fn();
  } finally {
    db.exec('COMMIT');
  }
}

export const now = () => new Date().toISOString();
