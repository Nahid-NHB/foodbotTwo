/** A single line in a cart. */
export interface CartItem {
  menu_item_id: string;
  name: string; // snapshot at add-time
  quantity: number;
  unit_price_paisa: number; // snapshot at add-time
  variant_id?: string;
  variant_name?: string;
  variant_price_paisa?: number;
  addon_ids: string[];
  addons: { id: string; name: string; price_paisa: number }[];
  line_total_paisa: number;
}

export interface Cart {
  items: CartItem[];
  subtotal_paisa: number;
  delivery_fee_paisa: number;
  total_paisa: number;
}

export interface AddToCartInput {
  menu_item_id: string;
  quantity: number;
  variant_id?: string;
  addon_ids?: string[];
}

export interface UpdateCartItemInput {
  menu_item_id: string;
  variant_id?: string;
  quantity: number;
}