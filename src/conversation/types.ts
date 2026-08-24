import type { CartItem } from '../cart/types.js';

export type ConversationState =
  | 'idle'
  | 'ordering'
  | 'awaiting_confirmation';

export interface Conversation {
  id: string;
  customer_id: string;
  restaurant_id: string;
  state: ConversationState;
  cart: CartItem[];
  last_message_at: string;
  created_at: string;
  updated_at: string;
}