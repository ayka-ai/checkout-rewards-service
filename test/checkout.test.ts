// Business rules and failure modes that do not need concurrency to expose.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, type TestServer } from './helpers.ts';

describe('carts and checkout rules', () => {
  let s: TestServer;
  before(async () => (s = await startServer()));
  after(() => s.close());

  test('invalid products and quantities never enter a cart', async () => {
    const c = s.client;
    const cartId = await c.newCart();
    const cases: [string, unknown, number, string][] = [
      ['p_nope', 1, 404, 'PRODUCT_NOT_FOUND'],
      ['p_mug', 0, 400, 'VALIDATION_ERROR'],
      ['p_mug', -2, 400, 'VALIDATION_ERROR'],
      ['p_mug', 1.5, 400, 'VALIDATION_ERROR'],
      ['p_mug', '2', 400, 'VALIDATION_ERROR'],
      ['p_mug', 1001, 400, 'VALIDATION_ERROR'],
      ['p_sneakers_ltd', 4, 409, 'INSUFFICIENT_INVENTORY'], // only 3 exist
    ];
    for (const [productId, quantity, status, code] of cases) {
      const r = await c.call('PUT', `/carts/${cartId}/items/${productId}`, { quantity });
      assert.equal(r.status, status, `${productId} x ${quantity}`);
      assert.equal(r.body.error.code, code);
    }
    const cart = await c.call('GET', `/carts/${cartId}`);
    assert.deepEqual(cart.body.items, []);
  });

  test('PUT quantity is absolute (retry-safe) and cart totals use integer paise', async () => {
    const c = s.client;
    const cartId = await c.newCart();
    await c.call('PUT', `/carts/${cartId}/items/p_stickers`, { quantity: 3 });
    const again = await c.call('PUT', `/carts/${cartId}/items/p_stickers`, { quantity: 3 }); // a retry
    await c.call('PUT', `/carts/${cartId}/items/p_mug`, { quantity: 2 });
    const cart = (await c.call('GET', `/carts/${cartId}`)).body;
    assert.equal(again.status, 200);
    assert.equal(cart.items.find((i: any) => i.productId === 'p_stickers').quantity, 3);
    assert.equal(cart.subtotalMinor, 3 * 3333 + 2 * 29_950);

    const removed = await c.call('DELETE', `/carts/${cartId}/items/p_mug`);
    const removedAgain = await c.call('DELETE', `/carts/${cartId}/items/p_mug`); // retried DELETE
    assert.equal(removed.status, 200);
    assert.equal(removedAgain.status, 200);
    assert.equal(removedAgain.body.subtotalMinor, 9999);
  });

  test('a price change after adding blocks checkout until the customer re-confirms; orders keep their snapshot', async () => {
    const c = s.client;
    const cartId = await c.newCart({ p_notebook: 2 });
    await c.call('PATCH', '/admin/products/p_notebook', { priceMinor: 15_000 });

    const view = (await c.call('GET', `/carts/${cartId}`)).body;
    assert.equal(view.readyForCheckout, false);
    assert.equal(view.items[0].priceChanged, true);

    const blocked = await c.checkout(cartId, 'price-1');
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'PRICE_CHANGED');
    assert.deepEqual(blocked.body.error.details.items, [
      { productId: 'p_notebook', acceptedUnitPriceMinor: 12_500, currentUnitPriceMinor: 15_000 },
    ]);

    await c.call('PUT', `/carts/${cartId}/items/p_notebook`, { quantity: 2 }); // re-confirm
    const ok = await c.checkout(cartId, 'price-2');
    assert.equal(ok.status, 201);
    assert.equal(ok.body.totalMinor, 30_000);

    // Later catalogue edits do not rewrite history.
    await c.call('PATCH', '/admin/products/p_notebook', { priceMinor: 1 });
    const order = await c.call('GET', `/orders/${ok.body.id}`);
    assert.deepEqual(order.body.lines, [
      { productId: 'p_notebook', productName: 'A5 Notebook', unitPriceMinor: 15_000, quantity: 2, lineTotalMinor: 30_000 },
    ]);
    await c.call('PATCH', '/admin/products/p_notebook', { priceMinor: 12_500 });
  });

  test('stock that ran out after adding fails checkout cleanly with nothing mutated', async () => {
    const c = s.client;
    const cartId = await c.newCart({ p_headphones: 5, p_mug: 1 });
    await c.call('PATCH', '/admin/products/p_headphones', { inventory: 2 });
    const mugBefore = await c.inventory('p_mug');

    const r = await c.checkout(cartId, 'stock-1');
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'INSUFFICIENT_INVENTORY');
    assert.deepEqual(r.body.error.details.items, [{ productId: 'p_headphones', requested: 5, available: 2 }]);
    assert.equal(await c.inventory('p_mug'), mugBefore, 'no partial decrement of other lines');
    assert.equal(await c.inventory('p_headphones'), 2);
    assert.equal((await c.call('GET', `/carts/${cartId}`)).body.status, 'OPEN');

    // The customer can fix the cart and the same failed key can be retried: failures are not cached.
    await c.call('PUT', `/carts/${cartId}/items/p_headphones`, { quantity: 2 });
    const retry = await c.checkout(cartId, 'stock-1');
    assert.equal(retry.status, 201);
    assert.equal(await c.inventory('p_headphones'), 0);
  });

  test('a cart is checked out at most once and is frozen afterwards', async () => {
    const c = s.client;
    const cartId = await c.newCart({ p_tshirt: 1 });
    const first = await c.checkout(cartId, 'once-1');
    assert.equal(first.status, 201);

    const replay = await c.checkout(cartId, 'once-1');
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get('idempotent-replayed'), 'true');
    assert.deepEqual(replay.body, first.body);

    const other = await c.checkout(cartId, 'once-2');
    assert.equal(other.status, 409);
    assert.equal(other.body.error.code, 'CART_ALREADY_CHECKED_OUT');
    assert.equal(other.body.error.details.orderId, first.body.id);

    const edit = await c.call('PUT', `/carts/${cartId}/items/p_tshirt`, { quantity: 5 });
    assert.equal(edit.status, 409);
    assert.equal(edit.body.error.code, 'CART_NOT_OPEN');
  });

  test('distinguishable errors for missing key, reused key, empty cart, unknown coupon', async () => {
    const c = s.client;
    const empty = await c.newCart();
    assert.equal((await c.call('POST', `/carts/${empty}/checkout`, {})).body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
    const emptyRes = await c.checkout(empty, 'empty-1');
    assert.equal(emptyRes.status, 422);
    assert.equal(emptyRes.body.error.code, 'CART_EMPTY');

    const a = await c.newCart({ p_mug: 1 });
    const b = await c.newCart({ p_mug: 1 });
    assert.equal((await c.checkout(a, 'shared-key')).status, 201);
    const reused = await c.checkout(b, 'shared-key');
    assert.equal(reused.status, 422);
    assert.equal(reused.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal((await c.call('GET', `/carts/${b}`)).body.status, 'OPEN', 'reused key must not touch cart b');

    const bad = await c.checkout(b, 'coupon-x', 'SAVE-DOESNOTEXIST');
    assert.equal(bad.status, 422);
    assert.equal(bad.body.error.code, 'COUPON_NOT_FOUND');

    assert.equal((await c.call('GET', '/carts/nope')).body.error.code, 'CART_NOT_FOUND');
    assert.equal((await c.call('GET', '/orders/nope')).body.error.code, 'ORDER_NOT_FOUND');
  });
});
