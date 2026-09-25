// Runtime configuration. Everything comes from environment variables so tests
// can spin up isolated instances with different reward rules.

export interface Config {
  port: number;
  dbPath: string;
  /** A coupon becomes available after every `rewardEveryNOrders` successfully placed orders. */
  rewardEveryNOrders: number;
  /** Whole-number percent off (1..100) for coupons generated from now on. */
  rewardDiscountPercent: number;
}

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const config: Config = {
    port: intFromEnv('PORT', 3000, 0, 65535),
    dbPath: process.env.DB_PATH ?? 'data/store.db',
    rewardEveryNOrders: intFromEnv('REWARD_EVERY_N_ORDERS', 5, 1, 1_000_000),
    rewardDiscountPercent: intFromEnv('REWARD_DISCOUNT_PERCENT', 10, 1, 100),
    ...overrides,
  };
  if (!Number.isInteger(config.rewardEveryNOrders) || config.rewardEveryNOrders < 1) {
    throw new Error('rewardEveryNOrders must be a positive integer');
  }
  if (
    !Number.isInteger(config.rewardDiscountPercent) ||
    config.rewardDiscountPercent < 1 ||
    config.rewardDiscountPercent > 100
  ) {
    throw new Error('rewardDiscountPercent must be an integer between 1 and 100');
  }
  return config;
}
