import express, { type NextFunction, type Request, type Response } from 'express';
import type { Config } from './config.ts';
import type { DB } from './db.ts';
import { AppError, errors } from './errors.ts';
import { createCart, parseQuantity, removeCartItem, setCartItem, viewCart } from './domain/carts.ts';
import { generateCoupon, listCoupons } from './domain/coupons.ts';
import { checkout, getOrder } from './domain/orders.ts';
import { getProduct, listProducts, updateProduct } from './domain/products.ts';
import { buildReport } from './domain/report.ts';

function body(req: Request): Record<string, unknown> {
  if (req.body === undefined || req.body === null) return {};
  if (typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw errors.validation('Request body must be a JSON object.');
  }
  return req.body as Record<string, unknown>;
}

function idempotencyKey(req: Request): string {
  const key = req.header('Idempotency-Key');
  if (!key) {
    throw new AppError(
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      'Checkout requires an Idempotency-Key header (e.g. a UUID generated once per checkout attempt and reused on retries).',
    );
  }
  if (key.length > 255 || !/^[\x21-\x7E]+$/.test(key)) {
    throw errors.validation('Idempotency-Key must be 1-255 printable ASCII characters without spaces.');
  }
  return key;
}

function optionalCouponCode(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '' || value.length > 64) {
    throw errors.validation('couponCode must be a non-empty string when provided.', { field: 'couponCode' });
  }
  return value;
}

function optionalNonNegativeInt(value: unknown, field: string, min: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw errors.validation(`${field} must be an integer >= ${min}.`, { field });
  }
  return value;
}

export function createApp(db: DB, config: Config) {
  const rules = {
    rewardEveryNOrders: config.rewardEveryNOrders,
    rewardDiscountPercent: config.rewardDiscountPercent,
  };
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // ---- Catalogue (public) ----
  app.get('/products', (_req, res) => {
    res.json({ products: listProducts(db) });
  });
  app.get('/products/:productId', (req, res) => {
    res.json(getProduct(db, req.params.productId));
  });

  // ---- Carts (public) ----
  app.post('/carts', (_req, res) => {
    const cart = createCart(db);
    res.status(201).location(`/carts/${cart.id}`).json(cart);
  });
  app.get('/carts/:cartId', (req, res) => {
    res.json(viewCart(db, req.params.cartId));
  });
  app.put('/carts/:cartId/items/:productId', (req, res) => {
    const quantity = parseQuantity(body(req).quantity);
    res.json(setCartItem(db, req.params.cartId, req.params.productId, quantity));
  });
  app.delete('/carts/:cartId/items/:productId', (req, res) => {
    res.json(removeCartItem(db, req.params.cartId, req.params.productId));
  });

  // ---- Checkout & orders (public) ----
  app.post('/carts/:cartId/checkout', (req, res) => {
    const key = idempotencyKey(req);
    const couponCode = optionalCouponCode(body(req).couponCode);
    const { order, replayed } = checkout(db, { cartId: req.params.cartId, idempotencyKey: key, couponCode });
    res
      .status(201)
      .location(`/orders/${order.id}`)
      .set('Idempotent-Replayed', String(replayed))
      .json(order);
  });
  app.get('/orders/:orderId', (req, res) => {
    res.json(getOrder(db, req.params.orderId));
  });

  // ---- Administration (would sit behind admin auth in production) ----
  app.post('/admin/coupons', (_req, res) => {
    const result = generateCoupon(db, rules);
    res.status(201).json(result);
  });
  app.get('/admin/coupons', (_req, res) => {
    res.json({ coupons: listCoupons(db) });
  });
  app.get('/admin/report', (_req, res) => {
    res.json(buildReport(db, rules));
  });
  app.patch('/admin/products/:productId', (req, res) => {
    const b = body(req);
    const patch = {
      priceMinor: optionalNonNegativeInt(b.priceMinor, 'priceMinor', 1),
      inventory: optionalNonNegativeInt(b.inventory, 'inventory', 0),
    };
    if (patch.priceMinor === undefined && patch.inventory === undefined) {
      throw errors.validation('Provide priceMinor and/or inventory.');
    }
    res.json(updateProduct(db, req.params.productId, patch));
  });

  // ---- Fallbacks ----
  app.use((req, _res, next) => {
    next(new AppError(404, 'ROUTE_NOT_FOUND', `No route for ${req.method} ${req.path}.`));
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      if (err.retryable) res.set('Retry-After', '1');
      res.status(err.status).json(err.toJSON());
      return;
    }
    const e = err as { type?: string; status?: number };
    if (e?.type === 'entity.parse.failed') {
      res.status(400).json(new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON.').toJSON());
      return;
    }
    if (e?.type === 'entity.too.large') {
      res.status(413).json(new AppError(413, 'VALIDATION_ERROR', 'Request body too large.').toJSON());
      return;
    }
    console.error(err);
    res.status(500).json(new AppError(500, 'INTERNAL_ERROR', 'Unexpected server error.', undefined, true).toJSON());
  });

  return app;
}
