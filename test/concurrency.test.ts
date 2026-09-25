// Competing and repeated operations. Every test fires requests at the same
// time (Promise.all over real HTTP connections) and then checks the invariant
// from the outside: counts of outcomes, inventory, and the admin report.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { countBy, startServer, type TestServer } from './helpers.ts';

describe('concurrent and repeated operations', () => {
  let s: TestServer;
  before(async () => (s = await startServer({ rewardEveryNOrders: 3, rewardDiscountPercent: 10 })));
  after(() => s.close());

  test('30 customers race for 3 limited sneakers: exactly 3 orders, never oversold', async () => {
    const c = s.client;
    const carts = await Promise.all(Array.from({ length: 30 }, () => c.newCart({ p_sneakers_ltd: 1 })));
    const results = await Promise.all(carts.map((id) => c.checkout(id, `race-${id}`)));

    assert.deepEqual(countBy(results, (r) => r.status), { 201: 3, 409: 27 });
    for (const r of results.filter((r) => r.status === 409)) {
      assert.equal(r.body.error.code, 'INSUFFICIENT_INVENTORY');
    }
    assert.equal(await c.inventory('p_sneakers_ltd'), 0);
    const report = (await c.call('GET', '/admin/report')).body;
    assert.equal(report.products.find((p: any) => p.productId === 'p_sneakers_ltd').quantitySold, 3);
  });

  test('a checkout retried 20 times concurrently with one key creates one order and charges stock once', async () => {
    const c = s.client;
    const before = await c.inventory('p_mug');
    const ordersBefore = (await c.call('GET', '/admin/report')).body.totalOrders;
    const cartId = await c.newCart({ p_mug: 4 });

    const results = await Promise.all(Array.from({ length: 20 }, () => c.checkout(cartId, 'retry-storm')));

    assert.ok(results.every((r) => r.status === 201));
    assert.equal(new Set(results.map((r) => r.body.id)).size, 1, 'all retries see the same order');
    assert.equal(results.filter((r) => r.headers.get('idempotent-replayed') === 'false').length, 1);
    assert.equal(await c.inventory('p_mug'), before - 4);
    assert.equal((await c.call('GET', '/admin/report')).body.totalOrders, ordersBefore + 1);
  });

  test('double-click with different keys on one cart: one order, the rest CART_ALREADY_CHECKED_OUT', async () => {
    const c = s.client;
    const cartId = await c.newCart({ p_notebook: 1 });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => c.checkout(cartId, `click-${i}`)));
    assert.deepEqual(countBy(results, (r) => r.status), { 201: 1, 409: 9 });
    const winner = results.find((r) => r.status === 201)!;
    for (const r of results.filter((r) => r.status === 409)) {
      assert.equal(r.body.error.code, 'CART_ALREADY_CHECKED_OUT');
      assert.equal(r.body.error.details.orderId, winner.body.id);
    }
  });

  test('two checkouts race for one coupon: one redeems it, the loser is untouched and can retry without it', async () => {
    const c = s.client;
    await c.placeOrders(3);
    const gen = await c.call('POST', '/admin/coupons');
    assert.equal(gen.status, 201);
    const code = gen.body.coupon.code;

    const cartA = await c.newCart({ p_tshirt: 1 });
    const cartB = await c.newCart({ p_tshirt: 1 });
    const stockBefore = await c.inventory('p_tshirt');
    const [a, b] = await Promise.all([c.checkout(cartA, 'coupon-a', code), c.checkout(cartB, 'coupon-b', code)]);

    const winner = [a, b].find((r) => r.status === 201)!;
    const loser = [a, b].find((r) => r.status !== 201)!;
    assert.ok(winner && loser, 'exactly one winner');
    assert.equal(winner.body.discountMinor, 4_990);
    assert.equal(loser.status, 409);
    assert.equal(loser.body.error.code, 'COUPON_ALREADY_REDEEMED');
    assert.equal(await c.inventory('p_tshirt'), stockBefore - 1, 'loser consumed no stock');

    const loserCart = loser === a ? cartA : cartB;
    assert.equal((await c.call('GET', `/carts/${loserCart}`)).body.status, 'OPEN');
    const noCoupon = await c.checkout(loserCart, 'coupon-loser-retry');
    assert.equal(noCoupon.status, 201);
    assert.equal(noCoupon.body.discountMinor, 0);

    const coupons = (await c.call('GET', '/admin/coupons')).body.coupons;
    assert.equal(coupons.find((x: any) => x.code === code).redeemedByOrderId, winner.body.id);
  });

  test('a coupon used on a checkout that fails is not consumed', async () => {
    const c = s.client;
    await c.placeOrders(3);
    const code = (await c.call('POST', '/admin/coupons')).body.coupon.code;

    const cartId = await c.newCart({ p_headphones: 2 });
    await c.call('PATCH', '/admin/products/p_headphones', { inventory: 1 });
    const failed = await c.checkout(cartId, 'fail-with-coupon', code);
    assert.equal(failed.body.error.code, 'INSUFFICIENT_INVENTORY');
    const coupon = (await c.call('GET', '/admin/coupons')).body.coupons.find((x: any) => x.code === code);
    assert.equal(coupon.status, 'AVAILABLE');

    await c.call('PUT', `/carts/${cartId}/items/p_headphones`, { quantity: 1 });
    const ok = await c.checkout(cartId, 'fail-with-coupon', code);
    assert.equal(ok.status, 201);
    assert.equal(ok.body.discount.couponCode, code);
  });

  test('ten admins generate concurrently for one eligible milestone: exactly one coupon', async () => {
    const c = s.client;
    while ((await c.call('POST', '/admin/coupons')).status === 201); // drain any backlog from earlier tests
    const status = (await c.call('GET', '/admin/report')).body.rewards;
    assert.equal(status.unrewardedMilestones, 0);
    const toNext = status.nextMilestoneAtOrderNumber - status.placedOrders;
    await c.placeOrders(toNext);

    const results = await Promise.all(Array.from({ length: 10 }, () => c.call('POST', '/admin/coupons')));
    assert.deepEqual(countBy(results, (r) => r.status), { 201: 1, 409: 9 });
    assert.ok(results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'NO_UNREWARDED_MILESTONE'));
    const milestones = (await c.call('GET', '/admin/coupons')).body.coupons.map((x: any) => x.milestone);
    assert.equal(new Set(milestones).size, milestones.length, 'no milestone rewarded twice');
  });
});
