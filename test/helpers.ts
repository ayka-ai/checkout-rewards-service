import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { openDatabase, type DB } from '../src/db.ts';

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export class Client {
  readonly baseUrl: string;
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async call<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers } as ApiResponse<T>;
  }

  async newCart(items: Record<string, number> = {}): Promise<string> {
    const cart = await this.call('POST', '/carts');
    for (const [productId, quantity] of Object.entries(items)) {
      const r = await this.call('PUT', `/carts/${cart.body.id}/items/${productId}`, { quantity });
      if (r.status !== 200) throw new Error(`setup failed: ${JSON.stringify(r.body)}`);
    }
    return cart.body.id;
  }

  checkout(cartId: string, key: string, couponCode?: string) {
    return this.call('POST', `/carts/${cartId}/checkout`, couponCode ? { couponCode } : {}, {
      'Idempotency-Key': key,
    });
  }

  async inventory(productId: string): Promise<number> {
    return (await this.call('GET', `/products/${productId}`)).body.availableInventory;
  }

  /** Place `count` simple one-sticker orders sequentially (to reach milestones). */
  async placeOrders(count: number) {
    for (let i = 0; i < count; i++) {
      const cartId = await this.newCart({ p_stickers: 1 });
      const r = await this.checkout(cartId, `fill-${cartId}`);
      if (r.status !== 201) throw new Error(`order failed: ${JSON.stringify(r.body)}`);
    }
  }
}

export interface TestServer {
  client: Client;
  db: DB;
  close(): Promise<void>;
}

/** An isolated in-process server with its own temp database. */
export async function startServer(overrides: Partial<Config> = {}): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'checkout-test-'));
  const config = loadConfig({ port: 0, dbPath: join(dir, 'store.db'), ...overrides });
  const db = openDatabase(config.dbPath);
  const server = createApp(db, config).listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    client: new Client(`http://127.0.0.1:${port}`),
    db,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          db.close();
          rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}

/** A separate OS process running the real server entrypoint against `dbPath`. */
export async function spawnServer(dbPath: string, env: Record<string, string> = {}) {
  const child: ChildProcess = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', 'src/server.ts'],
    { env: { ...process.env, DB_PATH: dbPath, PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const port = await new Promise<number>((resolve, reject) => {
    let out = '';
    child.stdout!.on('data', (chunk) => {
      out += chunk;
      const m = out.match(/LISTENING port=(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.once('exit', (code) => reject(new Error(`server exited early (${code})`)));
  });
  return {
    client: new Client(`http://127.0.0.1:${port}`),
    stop: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}

export function countBy<T>(items: T[], key: (t: T) => string | number) {
  const out: Record<string, number> = {};
  for (const i of items) out[key(i)] = (out[key(i)] ?? 0) + 1;
  return out;
}
