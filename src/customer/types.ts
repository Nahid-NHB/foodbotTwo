export interface Customer {
  id: string;
  phone_e164: string;
  name: string | null;
  default_address: string | null;
  payment_method: string | null;
  created_at: string;
  updated_at: string;
}

export interface CustomerUpdate {
  name?: string | null;
  default_address?: string | null;
  payment_method?: string | null;
}