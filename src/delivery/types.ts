export interface DeliveryZone {
  id: string;
  restaurant_id: string;
  name: string;
  eta_minutes: number;
  delivery_fee_paisa: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CustomerAddress {
  id: string;
  customer_id: string;
  zone_id: string;
  line1: string;
  line2: string | null;
  note_for_rider: string | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface CustomerAddressInput {
  zone_id: string;
  line1: string;
  line2?: string;
  note_for_rider?: string;
}