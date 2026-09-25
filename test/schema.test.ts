// Defence in depth: even if a future code path skipped the service-level
// checks, the database itself refuses to store a broken state.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, type TestServer } from './helpers.ts';

describe('schema-level invariants', () => {
  let s: TestServer;
  before(async () => (s = await startServer({ rewardEveryNOrders: 1 })));
  after(() => s.close());

  test('inventory cannot go negative', () => {
    assert.throws(() => s.db.prepare("UPDATE products SET inventory = -1 WHERE id = 'p_mug'").run(), /CHECK/);
  });

  test('a cart cannot become two orders and a coupon cannot discount two orders', async () => {
    const c = s.client;
    await c.placeOrders(1);
    const code = (await c.call('POST', '/admin/coupons')).body.coupon.code;
    const cartId = await c.newCart({ p_mug: 1 });
    const order = (await c.checkout(cartId, 'schema-1', code)).body;

    const insert = s.db.prepare(
      `INSERT INTO orders (id, order_number, cart_id, subtotal_minor, discount_minor, total_minor,
                           coupon_code, discount_percent, currency, created_at)
       VALUES (?, ?, ?, 100, 0, 100, ?, ?, 'INR', 'x')`,
    );
    assert.throws(() => insert.run('dup-cart', 999, cartId, null, null), /UNIQUE/);
    const otherCart = await c.newCart();
    assert.throws(() => insert.run('dup-coupon', 998, otherCart, code, 10), /UNIQUE/);
    assert.throws(
      () => s.db.prepare('UPDATE coupons SET redeemed_order_id = ? WHERE code = ?').run('someone-else', code),
      /FOREIGN KEY|UNIQUE/,
    );
    assert.ok(order.id);
  });

  test('an order total must equal subtotal minus discount and can never be negative', async () => {
    const cartId = await s.client.newCart();
    assert.throws(
      () =>
        s.db
          .prepare(
            `INSERT INTO orders (id, order_number, cart_id, subtotal_minor, discount_minor, total_minor, currency, created_at)
             VALUES ('neg', 997, ?, 100, 150, -50, 'INR', 'x')`,
          )
          .run(cartId),
      /CHECK/,
    );
  });
});
