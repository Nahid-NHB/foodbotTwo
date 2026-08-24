-- 001_init.sql
-- Phase 1 schema. Money in integer paisa. Idempotent.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS restaurants (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  whatsapp_phone_number_id text NOT NULL,
  whatsapp_business_account_id text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS categories (
  id uuid PRIMARY KEY,
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name text NOT NULL,
  sort_order int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS menu_items (
  id uuid PRIMARY KEY,
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  name text NOT NULL,
  description text,
  price_paisa int NOT NULL CHECK (price_paisa >= 0),
  is_available boolean NOT NULL DEFAULT true,
  -- Lower-cased name + bangla/banglish aliases used by trigram search.
  search_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_menu_items_search ON menu_items USING gin (search_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_menu_items_restaurant ON menu_items(restaurant_id) WHERE is_available;

CREATE TABLE IF NOT EXISTS menu_item_variants (
  id uuid PRIMARY KEY,
  menu_item_id uuid NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  name text NOT NULL,
  price_paisa int NOT NULL CHECK (price_paisa >= 0),
  is_available boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS menu_item_addons (
  id uuid PRIMARY KEY,
  menu_item_id uuid NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  name text NOT NULL,
  price_paisa int NOT NULL CHECK (price_paisa >= 0),
  is_available boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY,
  phone_e164 text NOT NULL UNIQUE,
  name text,
  default_address text,
  payment_method text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'idle',
  cart_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conversations_customer ON conversations(customer_id, restaurant_id);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  whatsapp_message_id text UNIQUE,
  direction text NOT NULL CHECK (direction IN ('inbound','outbound')),
  kind text NOT NULL CHECK (kind IN ('text','voice','system')),
  raw_payload jsonb NOT NULL,
  transcript text,
  llm_input jsonb,
  llm_output jsonb,
  tool_calls jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

DO $$ BEGIN
  CREATE TYPE order_state AS ENUM (
    'pending','confirmed','preparing','ready',
    'out_for_delivery','delivered','cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY,
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  state order_state NOT NULL DEFAULT 'pending',
  items jsonb NOT NULL,
  subtotal_paisa int NOT NULL,
  delivery_fee_paisa int NOT NULL DEFAULT 0,
  total_paisa int NOT NULL,
  delivery_address text,
  payment_method text,
  special_instructions text,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_restaurant_state ON orders(restaurant_id, state, created_at DESC);

CREATE TABLE IF NOT EXISTS order_events (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_state order_state,
  to_state order_state NOT NULL,
  actor text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id, created_at);

CREATE TABLE IF NOT EXISTS _migrations (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
