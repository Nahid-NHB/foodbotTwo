import { describe, it, expect } from 'vitest';
import {
  AppError,
  MenuItemNotFoundError,
  MenuItemUnavailableError,
  CartEmptyError,
  OrderNotConfirmableError,
  InvalidStateTransitionError,
  CustomerNotFoundError,
  ToolError,
} from './errors.js';

describe('errors', () => {
  it('each error carries code + customerMessage + status', () => {
    const e = new MenuItemNotFoundError('Chicken Burger');
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe('menu_item_not_found');
    expect(e.status).toBe(404);
    expect(e.customerMessage).toMatch(/Chicken Burger/);
    expect(e.customerMessage).toMatch(/মেনু/);
  });

  it('MenuItemUnavailableError uses 409', () => {
    const e = new MenuItemUnavailableError('Coke');
    expect(e.status).toBe(409);
    expect(e.code).toBe('menu_item_unavailable');
  });

  it('CartEmptyError uses 400', () => {
    const e = new CartEmptyError();
    expect(e.status).toBe(400);
  });

  it('OrderNotConfirmableError wraps reason', () => {
    const e = new OrderNotConfirmableError('cart modified');
    expect(e.message).toMatch(/cart modified/);
    expect(e.status).toBe(409);
  });

  it('InvalidStateTransitionError reflects both states', () => {
    const e = new InvalidStateTransitionError('delivered', 'cancelled');
    expect(e.message).toMatch(/delivered/);
    expect(e.message).toMatch(/cancelled/);
  });

  it('CustomerNotFoundError uses 404', () => {
    const e = new CustomerNotFoundError();
    expect(e.status).toBe(404);
  });

  it('ToolError allows custom code + customer message', () => {
    const e = new ToolError('foo', 'bangla text', 'english detail');
    expect(e.code).toBe('foo');
    expect(e.customerMessage).toBe('bangla text');
  });

  it('cause is forwarded', () => {
    const cause = new Error('underlying');
    const e = new AppError({
      code: 'x',
      message: 'top',
      customerMessage: 'bn',
      cause,
    });
    expect(e.cause).toBe(cause);
  });
});