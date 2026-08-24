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
  payment_method: string | null;
  special_instructions: string | null;
  confirmed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
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
  payment_method?: string | null;
  special_instructions?: string | null;
}