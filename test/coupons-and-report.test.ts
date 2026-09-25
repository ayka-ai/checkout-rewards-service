// Coupon milestone semantics and report reconciliation.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, type TestServer } from './helpers.ts';

describe('milestone coupons', () => {
  let s: TestServer;
  before(async () => (s = await startServer({ rewardEveryNOrders: 3, rewardDiscountPercent: 10 })));
  after(() => s.close());

  test('a coupon is generated only once per reached milestone, oldest milestone first', async () => {
    const c = s.client;
    await c.placeOrders(2);
    const early = await c.call('POST', '/admin/coupons');
    assert.equal(early.status, 409);
    assert.equal(early.body.error.code, 'NO_UNREWARDED_MILESTONE');
    assert.equal(early.body.error.details.nextMilestoneAtOrderNumber, 3);

    await c.placeOrders(4); // 6 orders placed -> milestones 1 and 2 reached, none rewarded
    const first = await c.call('POST', '/admin/coupons');
    assert.equal(first.status, 201);
    assert.equal(first.body.coupon.milestone, 1);
    assert.equal(first.body.coupon.earnedAtOrderNumber, 3);
    assert.equal(first.body.remainingUnrewardedMilestones, 1);

    const second = await c.call('POST', '/admin/coupons');
    assert.equal(second.body.coupon.milestone, 2);
    assert.equal((await c.call('POST', '/admin/coupons')).status, 409);
  });

  test('orders that redeem a coupon still count toward the next milestone', async () => {
    const c = s.client;
    const code = (await c.call('GET', '/admin/coupons')).body.coupons[0].code;
    const cartId = await c.newCart({ p_mug: 1 });
    assert.equal((await c.checkout(cartId, 'counted', code)).status, 201);
    await c.placeOrders(2); // 6 + 1 + 2 = 9 -> milestone 3
    const third = await c.call('POST', '/admin/coupons');
    assert.equal(third.status, 201);
    assert.equal(third.body.coupon.milestone, 3);
  });
});

describe('100% coupons', () => {
  let s: TestServer;
  before(async () => (s = await startServer({ rewardEveryNOrders: 1, rewardDiscountPercent: 100 })));
  after(() => s.close());

  test('a full discount brings the total to exactly zero, never below', async () => {
    const c = s.client;
    await c.placeOrders(1);
    const code = (await c.call('POST', '/admin/coupons')).body.coupon.code;
    const cartId = await c.newCart({ p_stickers: 7 });
    const r = await c.checkout(cartId, 'free', code.toLowerCase()); // codes are case-insensitive
    assert.equal(r.status, 201);
    assert.equal(r.body.subtotalMinor, 23_331);
    assert.equal(r.body.discountMinor, 23_331);
    assert.equal(r.body.totalMinor, 0);
  });
});

describe('admin report', () => {
  let s: TestServer;
  before(async () => (s = await startServer({ rewardEveryNOrders: 2, rewardDiscountPercent: 15 })));
  after(() => s.close());

  test('report reconciles with the orders and coupons the API returns, and reading it never mutates state', async () => {
    const c = s.client;
    const orderIds: string[] = [];
    const place = async (items: Record<string, number>, coupon?: string) => {
      const cartId = await c.newCart(items);
      const r = await c.checkout(cartId, `rep-${cartId}`, coupon);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      orderIds.push(r.body.id);
    };
    await place({ p_mug: 3, p_stickers: 1 });
    await place({ p_tshirt: 2 });
    const c1 = (await c.call('POST', '/admin/coupons')).body.coupon.code;
    await place({ p_mug: 3 }, c1); // 89,850 * 15% = 13,477.5 -> 13,478
    await place({ p_notebook: 1 });
    await c.call('POST', '/admin/coupons'); // generated, left unused
    // A failed checkout must not show up anywhere in the report.
    const failing = await c.newCart({ p_sneakers_ltd: 3 });
    await c.call('PATCH', '/admin/products/p_sneakers_ltd', { inventory: 0 });
    assert.equal((await c.checkout(failing, 'rep-fail')).status, 409);

    const orders = await Promise.all(orderIds.map(async (id) => (await c.call('GET', `/orders/${id}`)).body));
    const report = (await c.call('GET', '/admin/report')).body;

    const gross = orders.reduce((a, o) => a + o.subtotalMinor, 0);
    const discounts = orders.reduce((a, o) => a + o.discountMinor, 0);
    assert.equal(report.totalOrders, orders.length);
    assert.equal(report.grossRevenueMinor, gross);
    assert.equal(report.totalDiscountsMinor, discounts);
    assert.equal(report.totalDiscountsMinor, 13_478);
    assert.equal(report.netRevenueMinor, gross - discounts);
    assert.equal(report.netRevenueMinor, orders.reduce((a, o) => a + o.totalMinor, 0));
    assert.deepEqual(report.coupons, { generated: 2, available: 1, redeemed: 1 });

    const qty: Record<string, number> = {};
    for (const o of orders) for (const l of o.lines) qty[l.productId] = (qty[l.productId] ?? 0) + l.quantity;
    for (const p of report.products) assert.equal(p.quantitySold, qty[p.productId] ?? 0, p.productId);

    const again = await Promise.all([1, 2, 3].map(() => c.call('GET', '/admin/report')));
    for (const r of again) assert.deepEqual(r.body, report, 'repeated reports are identical');
  });
});
