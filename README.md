# Checkout & Rewards Service

Backend for a small store: carts, idempotent checkout that cannot oversell, a
coupon that becomes available after every *n*th order, and an admin report.

- **Stack:** Node.js 22 (runs TypeScript directly), Express 5, SQLite (built into Node via `node:sqlite`).
- **One runtime dependency** (Express). No database server, no credentials, no build step.
- The reasoning behind the design lives in **[DECISIONS.md](DECISIONS.md)**.

## Run it

Requires **Node.js ≥ 22.18** (for built-in TypeScript type-stripping and `node:sqlite`).

```bash
npm install
npm start                    # http://localhost:3000, database at data/store.db (seeded on first start)
npm test                     # 26 tests, ~4s, includes two-process concurrency tests
npm run typecheck            # optional: tsc --noEmit
```

Configuration (environment variables):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port (`0` = random) |
| `DB_PATH` | `data/store.db` | SQLite file. Delete it to reset to seed data. |
| `REWARD_EVERY_N_ORDERS` | `5` | *n*: a coupon milestone is reached every *n* successfully placed orders |
| `REWARD_DISCOUNT_PERCENT` | `10` | *x*: whole-number percent off (1–100) for newly generated coupons |

Example: `REWARD_EVERY_N_ORDERS=2 REWARD_DISCOUNT_PERCENT=15 npm start`

### Seed data

| id | name | price (paise) | inventory |
|---|---|---|---|
| `p_tshirt` | Cotton T-Shirt | 49 900 (₹499.00) | 100 |
| `p_mug` | Ceramic Mug | 29 950 (₹299.50) | 50 |
| `p_headphones` | Wireless Headphones | 249 900 (₹2,499.00) | 20 |
| `p_notebook` | A5 Notebook | 12 500 (₹125.00) | 200 |
| `p_stickers` | Sticker Pack | 3 333 (₹33.33) — exercises rounding | 500 |
| `p_sneakers_ltd` | Limited Edition Sneakers | 899 900 (₹8,999.00) | **3** (limited) |

## Conventions

- **Money:** every amount is an integer number of **paise** in fields ending in `Minor` (`29950` = ₹299.50). Currency is `INR`.
- **Errors:** always `{ "error": { "code", "message", "retryable", "details?" } }`. Branch on `code`.
  `400` malformed request · `404` unknown resource in the path · `409` conflicts with current state ·
  `422` well-formed but semantically unusable (empty cart, unknown coupon, reused idempotency key) · `503` retryable.
- **Admin endpoints** are everything under `/admin`. There is no auth; in production these would sit behind admin authentication.

## API

### Catalogue

| Method & path | Success | Notes / errors |
|---|---|---|
| `GET /products` | `200 { products: Product[] }` | |
| `GET /products/:productId` | `200 Product` | `404 PRODUCT_NOT_FOUND` |

`Product = { id, name, unitPriceMinor, currency, availableInventory }`

### Carts

| Method & path | Body | Success | Errors |
|---|---|---|---|
| `POST /carts` | – | `201 Cart` + `Location` | |
| `GET /carts/:cartId` | – | `200 Cart` | `404 CART_NOT_FOUND` |
| `PUT /carts/:cartId/items/:productId` | `{ "quantity": 1..1000 }` | `200 Cart` | `400 VALIDATION_ERROR` (non-integer, ≤0, >1000) · `404 CART_NOT_FOUND` / `PRODUCT_NOT_FOUND` · `409 INSUFFICIENT_INVENTORY` (more than currently in stock) · `409 CART_NOT_OPEN` (already checked out) |
| `DELETE /carts/:cartId/items/:productId` | – | `200 Cart` (also when the item was already gone, so retries are safe) | `404 CART_NOT_FOUND` · `409 CART_NOT_OPEN` |

`PUT` **sets** the quantity (adds the line if new). It is the "add item" and "change quantity" operation; it does not increment, so a retried request cannot double the quantity. Setting a line also **accepts the product's current price** (see price changes below).

```jsonc
// Cart
{
  "id": "…", "status": "OPEN" | "CHECKED_OUT", "currency": "INR",
  "items": [{
    "productId": "p_mug", "name": "Ceramic Mug", "quantity": 2,
    "unitPriceMinor": 29950,          // current price = what checkout would charge
    "acceptedUnitPriceMinor": 29950,  // price the customer last confirmed
    "priceChanged": false,
    "lineTotalMinor": 59900,
    "availableInventory": 50, "inStock": true
  }],
  "itemCount": 2, "subtotalMinor": 59900,
  "readyForCheckout": true,
  "issues": [],                        // e.g. { code: "PRICE_CHANGED" | "INSUFFICIENT_INVENTORY" | "CART_EMPTY", productId, message }
  "orderId": null,                     // set once checked out
  "createdAt": "…", "updatedAt": "…"
}
```

### Checkout and orders

`POST /carts/:cartId/checkout`

- Header **`Idempotency-Key`** (required): generate once per checkout attempt (e.g. a UUID) and **reuse it on every retry**.
- Body (optional): `{ "couponCode": "SAVE-…" }` (case-insensitive).

| Outcome | Status | Body |
|---|---|---|
| Order placed | `201` + `Location`, `Idempotent-Replayed: false` | `Order` |
| Retry with the same key and same request | `201`, `Idempotent-Replayed: true` | the **same** `Order` |
| Missing / malformed key | `400 IDEMPOTENCY_KEY_REQUIRED` / `VALIDATION_ERROR` | |
| Same key used before for a different cart or coupon | `422 IDEMPOTENCY_KEY_REUSED` | `details.orderId` |
| Cart unknown | `404 CART_NOT_FOUND` | |
| Cart already checked out (different key) | `409 CART_ALREADY_CHECKED_OUT` | `details.orderId` |
| Cart empty | `422 CART_EMPTY` | |
| A price changed since the item was added | `409 PRICE_CHANGED` | `details.items[{productId, acceptedUnitPriceMinor, currentUnitPriceMinor}]` — re-`PUT` the line to accept |
| Not enough stock | `409 INSUFFICIENT_INVENTORY` | `details.items[{productId, requested, available}]` (all short lines) |
| Coupon unknown | `422 COUPON_NOT_FOUND` | |
| Coupon already used | `409 COUPON_ALREADY_REDEEMED` | |
| Database contention timeout | `503 SERVICE_BUSY` + `Retry-After` | retry with the same key |

Failed checkouts change nothing (no stock, no coupon, cart stays `OPEN`) and are not cached, so after fixing the cart the client may retry with the same key.

`GET /orders/:orderId` → `200 Order` · `404 ORDER_NOT_FOUND`

```jsonc
// Order — an immutable snapshot; later product edits do not change it
{
  "id": "…", "orderNumber": 7, "cartId": "…", "status": "PLACED", "currency": "INR",
  "lines": [{ "productId": "p_mug", "productName": "Ceramic Mug", "unitPriceMinor": 29950, "quantity": 3, "lineTotalMinor": 89850 }],
  "subtotalMinor": 89850,
  "discount": { "couponCode": "SAVE-…", "percent": 15, "amountMinor": 13478,
                "rule": "round(subtotal * percent / 100) half-up to the nearest paisa, capped at subtotal" },
  "discountMinor": 13478,
  "totalMinor": 76372,
  "createdAt": "…"
}
```

### Administration

| Method & path | Body | Success | Errors |
|---|---|---|---|
| `POST /admin/coupons` | – | `201 { coupon: Coupon, remainingUnrewardedMilestones }` | `409 NO_UNREWARDED_MILESTONE` with `details` (placedOrders, milestonesReached, milestonesRewarded, nextMilestoneAtOrderNumber) |
| `GET /admin/coupons` | – | `200 { coupons: Coupon[] }` | |
| `GET /admin/report` | – | `200 Report` (read-only) | |
| `PATCH /admin/products/:productId` | `{ "priceMinor"?: int ≥ 1, "inventory"?: int ≥ 0 }` | `200 Product` | `400`, `404 PRODUCT_NOT_FOUND` |

`PATCH /admin/products` exists so you can reproduce "price or availability changed after the item was added".

`Coupon = { code, milestone, earnedAtOrderNumber, discountPercent, status: "AVAILABLE"|"REDEEMED", redeemedByOrderId, createdAt, redeemedAt }`

```jsonc
// Report
{
  "currency": "INR",
  "totalOrders": 4,
  "products": [{ "productId": "p_mug", "name": "Ceramic Mug", "quantitySold": 6, "grossRevenueMinor": 179700 }, …], // every product, 0 if unsold
  "grossRevenueMinor": 295333,     // Σ order subtotals (before discounts)
  "totalDiscountsMinor": 13478,    // Σ order discounts
  "netRevenueMinor": 281855,       // Σ order totals = gross − discounts
  "coupons": { "generated": 2, "available": 1, "redeemed": 1 },
  "rewards": { "discountPercentForNewCoupons": 15, "placedOrders": 4, "everyNOrders": 2,
               "milestonesReached": 2, "milestonesRewarded": 2, "unrewardedMilestones": 0, "nextMilestoneAtOrderNumber": 6 }
}
```

## Walk-through with curl

```bash
B=http://localhost:3000
CART=$(curl -s -X POST $B/carts | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')

curl -s -X PUT $B/carts/$CART/items/p_mug -H 'content-type: application/json' -d '{"quantity":2}'
curl -s $B/carts/$CART

KEY=$(node -e 'console.log(crypto.randomUUID())')
curl -s -i -X POST $B/carts/$CART/checkout -H "Idempotency-Key: $KEY"   # 201, Idempotent-Replayed: false
curl -s -i -X POST $B/carts/$CART/checkout -H "Idempotency-Key: $KEY"   # 201, same order, Idempotent-Replayed: true
curl -s -X POST $B/carts/$CART/checkout -H "Idempotency-Key: other"     # 409 CART_ALREADY_CHECKED_OUT

curl -s -X POST $B/admin/coupons     # 409 until n orders exist, then 201 with a code
curl -s $B/admin/report
```

## Tests

`npm test` runs everything. Highlights:

| File | What it proves |
|---|---|
| `test/concurrency.test.ts` | 30 concurrent buyers for 3 sneakers → exactly 3 orders; 20 concurrent retries with one key → one order, stock charged once; double-click with different keys → one order; two checkouts racing for one coupon → one winner, loser untouched; failed checkout does not consume a coupon; 10 concurrent coupon generations → one coupon |
| `test/multi-instance.test.ts` | Two **separate server processes** on one database file: no oversell, one order per idempotency key, one redemption per coupon |
| `test/checkout.test.ts` | Validation, price-change re-confirmation, order snapshots, stock shortfall with no partial writes, one checkout per cart, error codes |
| `test/coupons-and-report.test.ts` | Milestone semantics, 100% coupon → total exactly 0, report reconciles with `GET /orders` and is side-effect free |
| `test/money.test.ts` | Half-up rounding, cap at subtotal, rejection of non-integer money |
| `test/schema.test.ts` | The database itself rejects negative stock, duplicate orders per cart, double coupon use, inconsistent totals |

## Project layout

```
src/
  server.ts          entrypoint
  app.ts             HTTP routes, request validation, error mapping
  config.ts          n / x / port / db path
  db.ts              schema + constraints, seed, transaction helpers
  money.ts           integer money and discount rounding
  errors.ts          error codes
  domain/            products, carts, orders (checkout), coupons, report
test/                node:test suites
```
