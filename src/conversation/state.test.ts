import { describe, it, expect } from 'vitest';
import { canTransitionConversation, assertCanTransitionConversation } from './state.js';

describe('conversation state machine', () => {
  it('allows idle -> ordering', () => {
    expect(canTransitionConversation('idle', 'ordering')).toBe(true);
  });
  it('allows ordering -> awaiting_confirmation', () => {
    expect(canTransitionConversation('ordering', 'awaiting_confirmation')).toBe(true);
  });
  it('allows awaiting_confirmation -> ordering (modify)', () => {
    expect(canTransitionConversation('awaiting_confirmation', 'ordering')).toBe(true);
  });
  it('rejects idle -> awaiting_confirmation (must order first)', () => {
    expect(canTransitionConversation('idle', 'awaiting_confirmation')).toBe(false);
  });
  it('assertCanTransitionConversation throws on invalid', () => {
    expect(() => assertCanTransitionConversation('idle', 'awaiting_confirmation')).toThrow();
  });
});