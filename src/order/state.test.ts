import { describe, it, expect } from 'vitest';
import { canTransition, assertCanTransition, ORDER_STATES } from './state.js';
import { InvalidStateTransitionError } from '../common/errors.js';

describe('order state machine', () => {
  it('allows pending -> confirmed', () => {
    expect(canTransition('pending', 'confirmed')).toBe(true);
  });
  it('allows pending -> cancelled', () => {
    expect(canTransition('pending', 'cancelled')).toBe(true);
  });
  it('allows confirmed -> preparing', () => {
    expect(canTransition('confirmed', 'preparing')).toBe(true);
  });
  it('allows preparing -> ready', () => {
    expect(canTransition('preparing', 'ready')).toBe(true);
  });
  it('allows ready -> out_for_delivery', () => {
    expect(canTransition('ready', 'out_for_delivery')).toBe(true);
  });
  it('allows out_for_delivery -> delivered', () => {
    expect(canTransition('out_for_delivery', 'delivered')).toBe(true);
  });
  it('rejects skipping states (pending -> preparing)', () => {
    expect(canTransition('pending', 'preparing')).toBe(false);
  });
  it('rejects re-confirming a cancelled order', () => {
    expect(canTransition('cancelled', 'confirmed')).toBe(false);
  });
  it('rejects delivered -> anything', () => {
    expect(canTransition('delivered', 'delivered')).toBe(false);
    expect(canTransition('delivered', 'cancelled')).toBe(false);
  });
  it('rejects out_for_delivery -> cancelled (terminal route)', () => {
    expect(canTransition('out_for_delivery', 'cancelled')).toBe(false);
  });
  it('assertCanTransition throws on invalid', () => {
    expect(() => assertCanTransition('pending', 'delivered')).toThrow(InvalidStateTransitionError);
  });
  it('lists all 7 order states', () => {
    expect(ORDER_STATES.length).toBe(7);
    expect(new Set(ORDER_STATES).size).toBe(7);
  });
});