// Every client-visible failure is an AppError with a stable machine-readable
// `code`. Clients should branch on `code`, not on `message`.

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_JSON'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'ROUTE_NOT_FOUND'
  | 'PRODUCT_NOT_FOUND'
  | 'CART_NOT_FOUND'
  | 'ORDER_NOT_FOUND'
  | 'CART_NOT_OPEN'
  | 'CART_ALREADY_CHECKED_OUT'
  | 'CART_EMPTY'
  | 'INSUFFICIENT_INVENTORY'
  | 'PRICE_CHANGED'
  | 'COUPON_NOT_FOUND'
  | 'COUPON_ALREADY_REDEEMED'
  | 'NO_UNREWARDED_MILESTONE'
  | 'SERVICE_BUSY'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly retryable: boolean;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown, retryable = false) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export const errors = {
  validation: (message: string, details?: unknown) => new AppError(400, 'VALIDATION_ERROR', message, details),
  notFound: (code: ErrorCode, message: string) => new AppError(404, code, message),
  conflict: (code: ErrorCode, message: string, details?: unknown) => new AppError(409, code, message, details),
  unprocessable: (code: ErrorCode, message: string, details?: unknown) => new AppError(422, code, message, details),
};
