/**
 * Typed application errors. Each carries:
 *   - code: stable machine-readable identifier (snake_case)
 *   - customerMessage: Bangla text safe to send to the user
 *
 * Never leak raw exception messages to customers.
 */

export class AppError extends Error {
  public readonly code: string;
  public readonly customerMessage: string;
  public readonly status: number;

  constructor(opts: {
    code: string;
    message: string;
    customerMessage: string;
    status?: number;
    cause?: unknown;
  }) {
    super(opts.message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = this.constructor.name;
    this.code = opts.code;
    this.customerMessage = opts.customerMessage;
    this.status = opts.status ?? 400;
  }
}

export class MenuItemNotFoundError extends AppError {
  constructor(name: string, cause?: unknown) {
    super({
      code: 'menu_item_not_found',
      message: `Menu item not found: ${name}`,
      customerMessage: `দুঃখিত, "${name}" মেনুতে পাওয়া যায়নি।`,
      status: 404,
      cause,
    });
  }
}

export class MenuItemUnavailableError extends AppError {
  constructor(name: string, cause?: unknown) {
    super({
      code: 'menu_item_unavailable',
      message: `Menu item unavailable: ${name}`,
      customerMessage: `দুঃখিত, "${name}" এখন পাওয়া যাচ্ছে না।`,
      status: 409,
      cause,
    });
  }
}

export class CartEmptyError extends AppError {
  constructor(cause?: unknown) {
    super({
      code: 'cart_empty',
      message: 'Cart is empty',
      customerMessage: 'আপনার কার্ট খালি। কিছু অর্ডার করুন।',
      status: 400,
      cause,
    });
  }
}

export class OrderNotConfirmableError extends AppError {
  constructor(reason: string, cause?: unknown) {
    super({
      code: 'order_not_confirmable',
      message: `Order not confirmable: ${reason}`,
      customerMessage: 'অর্ডারটি এই মুহূর্তে কনফার্ম করা যাচ্ছে না।',
      status: 409,
      cause,
    });
  }
}

export class OrderNotFoundError extends AppError {
  constructor(id: string, cause?: unknown) {
    super({
      code: 'order_not_found',
      message: `Order not found: ${id}`,
      customerMessage: 'অর্ডার খুঁজে পাওয়া যায়নি।',
      status: 404,
      cause,
    });
  }
}

export class InvalidStateTransitionError extends AppError {
  constructor(from: string, to: string, cause?: unknown) {
    super({
      code: 'invalid_state_transition',
      message: `Invalid transition ${from} -> ${to}`,
      customerMessage: 'এই অপারেশনটি এই মুহূর্তে সম্ভব নয়।',
      status: 409,
      cause,
    });
  }
}

export class CustomerNotFoundError extends AppError {
  constructor(cause?: unknown) {
    super({
      code: 'customer_not_found',
      message: 'Customer not found',
      customerMessage: 'গ্রাহক খুঁজে পাওয়া যায়নি।',
      status: 404,
      cause,
    });
  }
}

export class ToolError extends AppError {
  constructor(code: string, customerMessage: string, message: string, cause?: unknown) {
    super({ code, message, customerMessage, status: 400, cause });
  }
}