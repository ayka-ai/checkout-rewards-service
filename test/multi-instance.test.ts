// Two separate server *processes* sharing one database file. Inside one Node
// process, synchronous handlers cannot interleave, so the in-process tests
// alone would not prove much about locking. Here the two processes genuinely
// run in parallel and contend on the database, which is the situation the
// transaction strategy is designed for.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countBy, spawnServer } from './helpers.ts';

describe('two service instances, one database', () => {
  let dir: string;
  let a: Awaited<ReturnType<typeof spawnServer>>;
  let b: Awaited<ReturnType<typeof spawnServer>>;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'checkout-multi-'));
    const dbPath = join(dir, 'shared.db');
    a = await spawnServer(dbPath, { REWARD_EVERY_N_ORDERS: '2' });
    b = await spawnServer(dbPath, { REWARD_EVERY_N_ORDERS: '2' });
  });
  after(async () => {
    await Promise.all([a.stop(), b.stop()]);
    rmSync(dir, { recursive: true, force: true });
  });

  test('checkouts split across instances never oversell', async () => {
    const carts = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).client.newCart({ p_sneakers_ltd: 1 })));
    const results = await Promise.all(
      carts.map((id, i) => (i % 2 ? b : a).client.checkout(id, `multi-${id}`)), // deliberately the *other* instance
    );
    assert.deepEqual(countBy(results, (r) => r.status), { 201: 3, 409: 37 });
    assert.equal(await a.client.inventory('p_sneakers_ltd'), 0);
    assert.equal(await b.client.inventory('p_sneakers_ltd'), 0);
  });

  test('the same idempotent checkout sent to both instances at once creates one order', async () => {
    const cartId = await a.client.newCart({ p_mug: 2 });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).client.checkout(cartId, 'multi-retry')),
    );
    assert.ok(results.every((r) => r.status === 201), JSON.stringify(results.map((r) => r.body)));
    assert.equal(new Set(results.map((r) => r.body.id)).size, 1);
  });

  test('one coupon raced from both instances is redeemed exactly once', async () => {
    const gen = await a.client.call('POST', '/admin/coupons'); // 3+1 = 4 orders so far, n=2
    assert.equal(gen.status, 201);
    const code = gen.body.coupon.code;
    const carts = await Promise.all(Array.from({ length: 8 }, () => a.client.newCart({ p_notebook: 1 })));
    const results = await Promise.all(carts.map((id, i) => (i % 2 ? a : b).client.checkout(id, `mc-${id}`, code)));
    assert.deepEqual(countBy(results, (r) => r.status), { 201: 1, 409: 7 });
    const report = (await b.client.call('GET', '/admin/report')).body;
    assert.equal(report.coupons.redeemed, 1);
    assert.equal(report.totalDiscountsMinor, 1_250);
  });
});
