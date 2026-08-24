export interface MenuItem {
  id: string;
  restaurant_id: string;
  category_id: string | null;
  name: string;
  description: string | null;
  price_paisa: number;
  is_available: boolean;
  search_text: string;
}

export interface MenuItemVariant {
  id: string;
  menu_item_id: string;
  name: string;
  price_paisa: number;
  is_available: boolean;
}

export interface MenuItemAddon {
  id: string;
  menu_item_id: string;
  name: string;
  price_paisa: number;
  is_available: boolean;
}

export interface MenuItemDetails extends MenuItem {
  variants: MenuItemVariant[];
  addons: MenuItemAddon[];
  category_name: string | null;
}

export interface MenuSearchResult {
  id: string;
  name: string;
  price_paisa: number;
  category_name: string | null;
  is_available: boolean;
  score: number;
}

export interface AvailabilityResult {
  available: boolean;
  reason?: string;
}