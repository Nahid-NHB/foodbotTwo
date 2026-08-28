export type OrderState =
  | 'pending'
  | 'confirmed'
  | 'preparing'
  | 'ready'
  | 'out_for_delivery'
  | 'delivered'
  | 'cancelled';

export interface OrderItemSnapshot {
  menu_item_id: string;
  name: string;
  quantity: number;
  unit_price_paisa: number;
  variant_id?: string;
  variant_name?: string;
  addon_ids: string[];
  addons: { id: string; name: string; price_paisa: number }[];
  line_total_paisa: number;
}

export interface Order {
  id: string;
  restaurant_id: string;
  customer_id: string;
  conversation_id: string | null;
  state: OrderState;
  items: OrderItemSnapshot[];
  subtotal_paisa: number;
  delivery_fee_paisa: number;
  total_paisa: number;
  delivery_address: string | null;
  delivery_zone_id: string | null;
  payment_method: string | null;
  special_instructions: string | null;
  confirmed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  requested_for: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateOrderInput {
  restaurant_id: string;
  customer_id: string;
  conversation_id?: string | null;
  items: OrderItemSnapshot[];
  delivery_fee_paisa: number;
  delivery_address?: string | null;
  delivery_zone_id?: string | null;
  payment_method?: string | null;
  special_instructions?: string | null;
}

export interface OrderHistoryRow {
  id: string;
  state: OrderState;
  items_summary: string;        // comma-separated item names e.g. "Chicken Burger × 2, Coke × 1"
  item_count: number;           // sum of quantities
  subtotal_paisa: number;
  delivery_fee_paisa: number;
  total_paisa: number;
  delivery_zone_id: string | null;
  requested_for: string | null;
  created_at: string;
  confirmed_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
}

export interface ListHistoryOptions {
  limit: number;       // 1..20
  beforeIso: string | null;
  includeTerminal: boolean;  // include delivered/cancelled; default false
}

export interface OrderModification {
  id: string;
  order_id: string;
  old_items: OrderItemSnapshot[];
  new_items: OrderItemSnapshot[];
  old_total_paisa: number;
  new_total_paisa: number;
  actor: 'customer' | 'staff' | 'system';
  created_at: string;
}

export type ApplyModificationInput = {
  orderId: string;
  customerId: string;
  newItems: OrderItemSnapshot[];
};

export type ApplyModificationResult = {
  order: Order;
  modification: OrderModification;
};

export type NotificationTemplate = {
  to_state: OrderState;
  bn: string;
};

export const NOTIFICATION_TEMPLATES: ReadonlyArray<NotificationTemplate> = [
  { to_state: 'confirmed', bn: 'আপনার অর্ডার #{order_id_short} কনফার্ম হয়েছে। প্রস্তুতি শুরু হবে শীঘ্রই।' },
  { to_state: 'preparing', bn: 'আপনার অর্ডার #{order_id_short} রান্না শুরু হয়েছে।' },
  { to_state: 'ready', bn: 'আপনার অর্ডার #{order_id_short} প্রস্তুত।' },
  { to_state: 'out_for_delivery', bn: 'আপনার অর্ডার #{order_id_short} ডেলিভারির জন্য বের হয়েছে।' },
  { to_state: 'delivered', bn: 'আপনার অর্ডার #{order_id_short} পৌঁছে গেছে। ধন্যবাদ!' },
  { to_state: 'cancelled', bn: 'আপনার অর্ডার #{order_id_short} বাতিল করা হয়েছে। কারণ: {note}' },
];

export interface OrderStatusNotification {
  id: string;
  order_id: string;
  to_state: OrderState;
  wamid: string | null;
  sent_at: string;
  delivered_at: string | null;
  failed_reason: string | null;
}