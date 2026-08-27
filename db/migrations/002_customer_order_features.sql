-- 002_customer_order_features.sql
-- Phase 2: customer-facing order features. Idempotent.

CREATE TABLE IF NOT EXISTS delivery_zones (
  id uuid PRIMARY KEY,
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name text NOT NULL,
  eta_minutes int NOT NULL CHECK (eta_minutes > 0),
  delivery_fee_paisa int NOT NULL CHECK (delivery_fee_paisa >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, name)
);

CREATE TABLE IF NOT EXISTS customer_addresses (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  -- zone_id may be NULL for legacy backfilled rows from customers.default_address
  -- (see Task 2 seed). New addresses created via set_delivery_address always
  -- pass a real zone; the application rejects NULL zone_id on input.
  zone_id uuid REFERENCES delivery_zones(id) ON DELETE RESTRICT,
  line1 text NOT NULL,
  line2 text,
  note_for_rider text,
  is_default boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Backfill amendment: drop NOT NULL on zone_id for legacy rows.
ALTER TABLE customer_addresses ALTER COLUMN zone_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customer_addresses_default
  ON customer_addresses(customer_id) WHERE is_default;

CREATE TABLE IF NOT EXISTS order_status_notifications (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  to_state order_state NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  failed_reason text,
  UNIQUE (order_id, to_state)
);

CREATE TABLE IF NOT EXISTS order_modifications (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  old_items jsonb NOT NULL,
  new_items jsonb NOT NULL,
  old_total_paisa int NOT NULL,
  new_total_paisa int NOT NULL,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS requested_for timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_zone_id uuid REFERENCES delivery_zones(id) ON DELETE SET NULL,
  -- delivered_at: timestamp when an order reached the 'delivered' state.
  -- Required by get_order_history (spec §5) and get_order_status. Set by
  -- OrderService.transition when transitioning to 'delivered'.
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
