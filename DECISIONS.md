# DECISIONS

This document explains *why* the service is built the way it is. The README covers how to run it and the API.

**Short version:** every state-changing operation is one SQLite write transaction that takes the write lock up front
(`BEGIN IMMEDIATE`). Inside it, each write that protects an invariant is a *guarded* statement (a compare-and-set that
must affect exactly one row), and the schema repeats the same rules as `CHECK`/`UNIQUE`/foreign-key constraints.
Checkout is made retry-safe by a client-supplied `Idempotency-Key` that is recorded in the same transaction as the order.
Money is integer paise. Tests fire real concurrent HTTP requests, including at two separate server processes sharing one
database file.

---

## 1. Invariants

| # | Invariant | Where it is enforced |
|---|---|---|
| I1 | Stock never goes below zero; we never sell more than we have. | Pre-check of all lines in `checkout()` → guarded `UPDATE products SET inventory = inventory - q WHERE id = ? AND inventory >= q` (must change 1 row) → `CHECK (inventory >= 0)` |
| I2 | A cart produces at most one order. | Cart status check → guarded `UPDATE carts SET status='CHECKED_OUT' WHERE id = ? AND status='OPEN'` → `orders.cart_id UNIQUE` |
| I3 | Retrying a checkout never creates a second order or charges stock twice. | `idempotency_keys` row written in the same transaction as the order; lookup is the first step of `checkout()`; `key PRIMARY KEY`; plus I2 |
| I4 | A coupon is redeemed at most once. | Pre-check → guarded `UPDATE coupons SET redeemed_order_id = ? WHERE code = ? AND redeemed_order_id IS NULL` → `coupons.redeemed_order_id UNIQUE`, `orders.coupon_code UNIQUE` |
| I5 | A failed checkout changes nothing: no stock, no coupon, cart still open. | Everything is inside one transaction; any thrown error rolls it back (`transaction()` in `db.ts`) |
| I6 | At most one coupon per order milestone; a coupon only exists for a milestone that was actually reached. | `generateCoupon()` computes milestones inside the write transaction → `coupons.milestone UNIQUE` |
| I7 | An order total is `subtotal − discount`, `0 ≤ discount ≤ subtotal`, total never negative. | `percentDiscount()` caps at subtotal → `CHECK (total_minor = subtotal_minor - discount_minor)`, `CHECK (discount_minor <= subtotal_minor)` |
| I8 | An order explains itself forever: what was bought, at what unit price, and how the total was computed. | `order_lines` copies product name and unit price; `orders` stores subtotal, coupon code, percent and discount; `CHECK (line_total = unit_price * quantity)` |
| I9 | A customer is never charged a price they did not see and accept. | `cart_items.accepted_price_minor`; checkout fails with `PRICE_CHANGED` if any line differs |
| I10 | The report reconciles with orders and coupons and reading it has no side effects. | Report is computed only from `orders`, `order_lines`, `coupons`, inside one read snapshot; no counters, no writes |

The two-layer pattern (service check for a precise error + database guard for correctness) is deliberate: the service
check produces a helpful `409` with details, the guard makes the invariant hold even if the check is wrong or races.

## 2. Ambiguities and the semantics I chose

| Question the brief leaves open | Choice |
|---|---|
| What happens when price changes between add-to-cart and checkout? | Checkout is **blocked** with `409 PRICE_CHANGED` (listing old and new price). The customer accepts by `PUT`-ing the line again. See D3. |
| What happens when availability drops before checkout? | Nothing is reserved at add time. Checkout re-checks and fails with `409 INSUFFICIENT_INVENTORY` listing *every* short line. The cart view shows `inStock:false` early. See D2. |
| Is "add item" an increment or a set? | A **set** (`PUT .../items/:productId {quantity}`), so retries are harmless. See D7. |
| What counts as "successfully placed order" for milestones? | Every committed order, **including orders that used a coupon**. Failed checkouts never count. |
| If several milestones are unrewarded, what does one admin request do? | Generates **one** coupon, for the **oldest** unrewarded milestone, and reports how many remain. Earned milestones are never forfeited. See D6. |
| Who can use a coupon? | Anyone holding the code (bearer coupon). There are no customer accounts in scope. |
| Can coupons be stacked? | No. One coupon per order. |
| Does a coupon expire? | No (deferred). |
| What does a coupon discount? | *x*% of the order subtotal, rounded half-up to the paisa, capped at the subtotal. The percent is **frozen on the coupon when generated**, so changing *x* later does not change existing coupons. |
| What if a coupon is supplied to a checkout that fails? | The coupon stays available (I5). |
| Coupon on an empty cart / cart with a problem? | Cart problems are reported first (`CART_EMPTY`, `PRICE_CHANGED`, `INSUFFICIENT_INVENTORY`), then coupon problems. The order of checks is fixed so errors are deterministic. |
| Are coupon codes case-sensitive? | No; codes are trimmed and upper-cased. |
| Does a failed checkout "use up" its idempotency key? | No. Only successes are recorded; a failed attempt had no side effects, so the same key can be retried after fixing the cart. |
| What if the same key is sent for a different cart or coupon? | `422 IDEMPOTENCY_KEY_REUSED` — it is a client bug, and replaying the old order would be wrong. |
| Can the cart be edited after checkout? | No, `409 CART_NOT_OPEN` (includes the order id). |
| Does *n* change at runtime? | *n* and *x* come from configuration at start-up. Milestones are counted with the current *n*; changing *n* on an existing database re-interprets the milestone count (documented limitation). |

## 3. Material design decisions

### Decision D1: SQLite with lock-up-front transactions, guarded writes and schema constraints

**Context:** Every hard requirement (no oversell, no double order, no double coupon) is a read-check-write race. The
brief allows in-memory storage but asks how the design holds up across instances.

**Options considered:**
1. In-memory maps with a per-resource mutex.
2. PostgreSQL in Docker.
3. Embedded SQLite (Node's built-in `node:sqlite`).

**Choice:** SQLite, WAL mode, every write path in `BEGIN IMMEDIATE … COMMIT`, plus guarded `UPDATE … WHERE <invariant still holds>` statements checked for `changes === 1`, plus `CHECK`/`UNIQUE` constraints.

**Why:**
- In-memory would only prove correctness inside one process; the interesting failures (two instances, crash mid-checkout) are invisible there, and rollback would have to be hand-written.
- Postgres is the production answer but adds Docker as a setup dependency for evaluators and did not buy much extra signal inside the timebox.
- SQLite gives real transactions, real constraints, real multi-process locking and zero setup. `BEGIN IMMEDIATE` takes the single write lock *before* reading, so read→validate→write cannot interleave with another writer, even from another process.
- The guarded statements are written as they would be for Postgres (they do not depend on SQLite having a single writer). That keeps the logic portable and gives a second line of defence.

**Consequences:** Easy to run, strong guarantees, and the multi-instance test is possible. The cost is throughput: SQLite
allows one writer at a time, and `node:sqlite` is synchronous, so while one process waits on another's lock (up to
`busy_timeout` = 5 s) its event loop is blocked. Fine for this scope; not for production load (see §8).

### Decision D2: Validate stock at checkout; do not reserve it at add-to-cart

**Context:** "Must not oversell" vs. "carts can hold products".

**Options considered:** (a) reserve stock when added to cart, with expiry; (b) check at add time, enforce only at checkout.

**Choice:** (b). `PUT` refuses quantities above current stock (fast feedback), but only checkout's guarded decrement is authoritative.

**Why:** Reservations need expiry, a sweeper and release on cart abandonment; without those, abandoned carts would lock
up the 3 limited sneakers forever — a worse failure than a customer seeing "sold out" at checkout. Checking at checkout
is the simplest rule that is always correct.

**Consequences:** A customer can see `inStock: true` and still lose the race at checkout (clear `409` with details). For
flash sales, short-lived reservations would be the next step.

### Decision D3: Checkout never silently charges a changed price

**Context:** Price may change between add and checkout.

**Options considered:** (a) charge the current price silently; (b) honour the price at add time; (c) block and ask the customer to re-confirm.

**Choice:** (c). Each cart line stores `accepted_price_minor`. The cart view flags `priceChanged`. Checkout fails with `409 PRICE_CHANGED` (old and new prices). Re-`PUT`-ing the line accepts the new price.

**Why:** (a) charges people amounts they never saw — a trust and legal problem when the price rose. (b) lets a stale cart
lock in an old price forever (abuse if a price was wrong and got corrected). (c) is explicit and cheap to implement.

**Consequences:** One extra round-trip for the client when a price moves. A price *drop* also blocks — slightly strict,
but the rule is simple and symmetric. Could be relaxed to "auto-accept decreases" later.

### Decision D4: Idempotency via a required `Idempotency-Key` recorded atomically with the order

**Context:** Clients retry checkout after timeouts; the retry must return the original result, not a second order.

**Options considered:**
1. Rely only on "a cart can be checked out once" (the cart id as the natural key).
2. `Idempotency-Key` header, storing the full response, including failures.
3. `Idempotency-Key` header mapped to the order, success-only, written in the same transaction.

**Choice:** (3), with (1) kept as a second guarantee.

**Why:**
- With (1) alone, a retry after a lost response gets `409 CART_ALREADY_CHECKED_OUT`, and the client cannot tell "my request succeeded" from "someone else checked this cart out". With a key, the retry receives the *same* `201` and order body (`Idempotent-Replayed: true`).
- Recording failures (2) would force a client that fixed its cart to invent a new key, and stored error bodies go stale (stock may have come back). A failed checkout has no side effects, so re-executing it is safe.
- Writing the key in the same transaction as the order means "key exists" ⇔ "order committed"; there is no window where a key points to nothing or an order exists without its key.
- The request fingerprint is `(cartId, couponCode)`. A different fingerprint for a known key is `422 IDEMPOTENCY_KEY_REUSED` rather than a silent replay of an unrelated order.

**Consequences:** Clients must send a key (a `400` tells them). Keys are global and never expire (deferred: scope to a client/session, TTL).

### Decision D5: Coupon redemption is a compare-and-set inside the checkout transaction

**Context:** A coupon must not be redeemed twice, and must not be consumed by a checkout that fails.

**Options considered:** (a) mark the coupon used first, then place the order (and "un-use" on failure); (b) a coupon state machine with a `RESERVED` state; (c) claim it inside the same transaction as the order.

**Choice:** (c). After the order row and stock decrements, `UPDATE coupons SET redeemed_order_id = :order WHERE code = :code AND redeemed_order_id IS NULL`, requiring exactly one changed row.

**Why:** (a) needs compensation logic that can itself fail (crash between steps = lost coupon). (b) is what you need when
payment is an external, slow step — not needed here. (c) makes redemption and order creation one atomic fact; if
anything later fails, the rollback un-claims the coupon for free.

**Consequences:** Two racing checkouts: one commits, the other gets `409 COUPON_ALREADY_REDEEMED` with its cart still open
and its stock untouched (tested, including across processes). If a real payment step is added, this becomes (b); see §8.

### Decision D6: Milestones are numbered and rewarded oldest-first, one per admin request

**Context:** "Every *n*th order makes one coupon available; an admin requests generation."

**Options considered:** (a) generate all missing coupons in one request; (b) only reward the latest milestone, forfeit older ones; (c) one coupon per request for the oldest unrewarded milestone.

**Choice:** (c). Milestone *k* is reached when `placedOrders ≥ k·n`. Coupon rows carry `milestone` with a `UNIQUE` constraint.

**Why:** Forfeiting earned rewards (b) is surprising. One-per-request (c) keeps the admin action small and auditable,
and the response says how many remain. The `UNIQUE(milestone)` constraint makes "one coupon per milestone" hold even if
two admins click at once (tested with 10 concurrent requests).

**Consequences:** An admin who wants all backlog coupons calls repeatedly. Easy to switch to (a) — loop inside the same transaction.

### Decision D7: `PUT` with an absolute quantity instead of "add N"

**Context:** Cart edits are retried too, and they are not protected by idempotency keys.

**Options considered:** `POST /items {productId, quantity}` that increments; `PUT /items/:productId {quantity}` that sets.

**Choice:** `PUT` sets the quantity; `DELETE` succeeds even if the line is already gone.

**Why:** Both operations are naturally idempotent, so no extra machinery is needed for cart retries. A retried increment would silently double the quantity.

**Consequences:** The client must know the desired total quantity (it has the cart). Concurrent edits to the same line are last-write-wins, which is acceptable for a single shopper's cart.

### Decision D8: No payment fake — a committed checkout *is* the payment

**Context:** The brief allows treating checkout as payment success, or a fake.

**Choice:** No payment abstraction.

**Why:** A fake that always succeeds adds code but no behaviour. A fake that can fail or time out would be worth
building only together with the state machine that real payments need (`PENDING → PAID/FAILED`, stock and coupon held
while pending, webhooks). That is a larger design (§8) and would have taken time away from the invariants the brief
actually tests.

**Consequences:** The order is created in its final state, `PLACED`. The evolution path is documented below.

### Decision D9: The report is computed from the ledger, not from counters

**Context:** The report must reconcile with orders and coupons and must not mutate state.

**Options considered:** running counters updated at checkout vs. aggregation over `orders`, `order_lines`, `coupons`.

**Choice:** Aggregation inside one read snapshot.

**Why:** Counters can drift from the truth (a bug in one code path and they never agree again). Summing the stored
orders is reconciling by construction, and the snapshot makes all figures describe the same instant even while
checkouts run.

**Consequences:** O(orders) per report; fine here, would move to a read replica or incrementally maintained summary at scale.

## 4. Transaction, concurrency and idempotency strategy

### Checkout, step by step (one `BEGIN IMMEDIATE` transaction, `src/domain/orders.ts`)

1. Look up `Idempotency-Key`. Known + same fingerprint → return stored order (`replayed: true`). Known + different → `422`.
2. Cart exists (`404`), is `OPEN` (`409 CART_ALREADY_CHECKED_OUT` + order id), is non-empty (`422`).
3. All lines at accepted price (`409 PRICE_CHANGED`).
4. All lines in stock (`409 INSUFFICIENT_INVENTORY`, all short lines listed).
5. Compute subtotal from integer line totals.
6. Coupon exists (`422`) and is unredeemed (`409`); discount = `percentDiscount(subtotal, coupon.percent)`.
7. Insert order and order lines (snapshot).
8. Guarded stock decrement per line (lines processed in `product_id` order, so in a row-locking database concurrent checkouts lock rows in the same order and cannot deadlock).
9. Guarded coupon claim.
10. Guarded cart close.
11. Insert idempotency key. `COMMIT`.

Any error → `ROLLBACK`; nothing from steps 7–11 survives.

### What happens under overlap

| Scenario | Outcome | Test |
|---|---|---|
| 30 buyers, 3 units | 3 × `201`, 27 × `409 INSUFFICIENT_INVENTORY`, stock 0 | `concurrency.test.ts`, and across 2 processes in `multi-instance.test.ts` |
| Same request + key sent 20× at once | 20 × `201`, one order, one `Idempotent-Replayed: false` | both files |
| Same cart, 10 different keys | 1 × `201`, 9 × `409 CART_ALREADY_CHECKED_OUT` pointing at the winner | `concurrency.test.ts` |
| Two carts, one coupon | 1 × `201` with discount, 1 × `409 COUPON_ALREADY_REDEEMED`; loser's stock and cart untouched | both files |
| Coupon on a checkout that fails | coupon stays `AVAILABLE`, usable later | `concurrency.test.ts` |
| 10 admins generate for 1 milestone | 1 × `201`, 9 × `409 NO_UNREWARDED_MILESTONE` | `concurrency.test.ts` |
| Lock held too long by another process | `503 SERVICE_BUSY` + `Retry-After`; safe to retry with the same key | (by construction) |

**Why the in-process tests are not enough on their own:** Node handlers here are synchronous, so within one process two
checkouts cannot interleave at all — a test there would pass even without locking. That is why
`multi-instance.test.ts` spawns two real server processes against one database file; those do contend.

### Do the tests actually catch broken code?

I broke the implementation on purpose and re-ran the suite (then reverted):

| Mutation | Tests that failed |
|---|---|
| Skip the idempotency-key lookup | 4 (concurrent retry storm, cross-process retry, sequential replay, reused-key detection) |
| Never mark the coupon redeemed | 3 (coupon race, cross-process coupon race, report reconciliation) |
| `BEGIN` instead of `BEGIN IMMEDIATE` | 3 (all multi-instance tests) |
| Remove the price-change check | 1 (price change test) |

The `BEGIN` mutation is instructive: SQLite still refuses to corrupt data (a deferred transaction that tries to upgrade
from read to write while another process writes fails with `SQLITE_BUSY` instead of silently losing an update), but
clients get spurious `503`s. Taking the lock up front turns that into a short wait.

## 5. Money and rounding

- All amounts are **integer paise** (`…Minor` fields). There is no floating-point money anywhere.
- Line total = `unit price × quantity` (integer). Subtotal = Σ line totals.
- Discount = `floor((subtotal × percent + 50) / 100)` → percent of the subtotal, **rounded half-up to the nearest paisa**, then `min(discount, subtotal)`. Exact in integer arithmetic, deterministic, and never makes a total negative (a 100% coupon gives exactly 0, tested).
- The discount is applied to the **order subtotal**, not per line, so there is a single rounding step (no per-line rounding drift).
- Every arithmetic result is checked with `Number.isSafeInteger`; overflow throws instead of losing precision. Quantity is capped at 1000 per line.
- Percent is a whole number 1–100. Fractional percents would need basis points; deferred.
- Single currency (INR). Multi-currency is out of scope.

## 6. Error model

- One shape: `{ error: { code, message, retryable, details? } }`. `code` is stable and meant for programs; `message` is for humans; `details` carries the data needed to recover (which lines are short, old vs new price, the existing order id).
- Status codes: `400` request is malformed (bad JSON, wrong types, missing idempotency key) · `404` a resource named in the **path** does not exist · `409` the request conflicts with current state and may succeed after the state changes or the client adjusts (stock, price, coupon already used, cart closed) · `422` well-formed but semantically unusable (empty cart, unknown coupon code in the body, reused key) · `503` transient, `retryable: true`, `Retry-After` set.
- Unknown coupon is `422` not `404` because the URL (the cart) exists; the problem is a value in the body.
- Unexpected errors are `500 INTERNAL_ERROR` with no internals leaked; the stack is logged.

## 7. Implemented vs. deliberately deferred

**Implemented:** everything in the brief's minimum API; admin product edits (to demonstrate price/stock changes);
idempotent checkout; cross-process concurrency safety; schema-level invariants; 26 tests including multi-process races;
mutation check of the tests.

**Deferred (with reason):**
- **Authentication/authorization**, including protecting `/admin/*` — out of scope per brief.
- **Payment integration / pending orders** — see D8 and §8.
- **Stock reservations with expiry** — see D2.
- **Coupon expiry, per-customer ownership, stacking rules** — no customer model in scope.
- **Idempotency key scoping and TTL** — keys are global and kept forever. Fine at this scale; in production keys are scoped per client and purged after e.g. 24 h.
- **Cart expiry / abandoned cart clean-up.**
- **Pagination** on `GET /admin/coupons`.
- **OpenAPI file** — the README tables and examples document the API instead.
- **Structured logging, metrics, request ids, rate limiting.**
- **Changing *n* on a live database** re-interprets milestone counts; a real system would record milestone boundaries as they are crossed.

## 8. Multiple instances and production scale

What already works: the multi-instance test runs two processes on one SQLite file. SQLite's single write lock
serializes the checkout transactions across processes. That does not scale beyond one machine, so in production:

1. **PostgreSQL**, `READ COMMITTED` is sufficient because the invariants are enforced by guarded statements, not by
   what a transaction read earlier: `UPDATE … WHERE inventory >= q` re-checks the predicate against the latest committed
   row after waiting for the row lock. Same for the coupon claim and the cart close. The `UNIQUE`/`CHECK` constraints move over unchanged.
   Lock only the rows involved (`SELECT … FOR UPDATE` on the cart), always in `product_id` order to avoid deadlocks.
2. **Order number:** replace `MAX(order_number)+1` (safe only because SQLite has one writer) with a sequence.
   Sequences have gaps on rollback, so milestone counting would use `COUNT(*)` of placed orders or a single counter row
   updated in the checkout transaction — the counter row is a hot spot, so at high volume I would count asynchronously
   (milestones only need to be *eventually* rewardable by an admin, not instant).
3. **Idempotency keys** under concurrency: insert the key first with state `IN_PROGRESS` (a unique-key conflict tells a
   concurrent duplicate to wait or return `409 in progress`), then finish the order and mark it `COMPLETED` with the
   response. Needed once checkout includes a slow external payment call that cannot sit inside a DB transaction.
4. **Payments:** order becomes `PENDING_PAYMENT`; stock and coupon are held (reserved state) until the provider confirms
   (webhook, itself idempotent by provider event id), then `PAID`, or released on failure/timeout by a sweeper. The
   provider call carries our idempotency key so provider retries cannot double-charge.
5. **Hot products:** a limited-stock product is one row every buyer contends on. For flash sales: short-lived
   reservations, or a queue per hot SKU, or splitting stock into buckets.
6. **Reporting:** run on a read replica or maintain a summary table from an outbox/event stream; the ledger stays the source of truth for reconciliation.
7. Stateless app instances behind a load balancer; nothing is kept in process memory, so no sticky sessions are needed.

## 9. How I used AI tools

- I used Claude as a pair: chat to talk through the design (invariants, idempotency semantics, coupon rules) and an agentic coding session to draft the code, tests and documents. I ran the service and the full test suite myself on Windows and read every file before submitting.
- I treated generated tests with suspicion: a suite that only ever passes proves nothing. So the implementation was deliberately broken four ways (§4, "Do the tests actually catch broken code?") to confirm the concurrency and idempotency tests actually fail when the guard they target is removed.
- Output that was corrected or redirected during the work:
  - **DELETE on a cart item:** the first version returned `404` when the item was already gone. That breaks retries: a client whose first DELETE succeeded but whose response was lost would see an error. It was changed to succeed idempotently and return the cart (D7).
  - **A test with a hidden dependency on earlier tests:** one concurrency test assumed no unrewarded milestones were left over from earlier tests in the same file. The fix was to drain the backlog first, not to weaken the assertion.
  - **In-process concurrency tests are not proof on their own:** Node handlers here are synchronous, so two requests in one process can never interleave and those tests would pass even without locking. That is why the two-process test (`multi-instance.test.ts`) exists, and why the `BEGIN` vs `BEGIN IMMEDIATE` mutation is checked against it.

## 10. What I would examine first with two more hours

1. **Payment as a separate step** (§8.3–8.4): `PENDING` orders, reserved stock and coupons, sweeper, and tests for "payment fails after stock was held" and "webhook arrives twice".
2. **A Postgres adapter behind the same domain functions**, and run the existing concurrency suite against it with N app processes — the guarded statements were written for this.
3. **Idempotency key scoping + TTL**, and an `IN_PROGRESS` state so a duplicate that arrives during a long checkout gets a clear answer.
4. **Property-based test** for money: random carts × random percents, assert `0 ≤ total ≤ subtotal` and report = Σ orders.
5. Look again at whether blocking on a price *decrease* (D3) is the right product call.

## Time spent

About **1 hour** of building in a single session on Sep 25 (visible in the commit history), working with an AI coding assistant, plus additional time reviewing the code, running the tests on Windows, and preparing to explain every decision. The build came in well under the 4–6 hour timebox because the AI drafted most of the code; my time went mainly into the design choices, verification and review.
