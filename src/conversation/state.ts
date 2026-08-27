import { InvalidStateTransitionError } from '../common/errors.js';
import type { ConversationState } from './types.js';

const ALLOWED: Record<ConversationState, ReadonlyArray<ConversationState>> = {
  idle: ['ordering'],
  ordering: ['awaiting_confirmation', 'idle', 'awaiting_modify_confirmation'],
  awaiting_confirmation: ['ordering', 'idle'],
  awaiting_modify_confirmation: ['idle', 'ordering'],
};

export function canTransitionConversation(from: ConversationState, to: ConversationState): boolean {
  return ALLOWED[from].includes(to);
}

export function assertCanTransitionConversation(
  from: ConversationState,
  to: ConversationState,
): void {
  if (!canTransitionConversation(from, to)) {
    throw new InvalidStateTransitionError(from, to);
  }
}