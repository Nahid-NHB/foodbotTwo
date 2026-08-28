import { z } from 'zod';
import type { FunctionDeclaration } from './gemini.js';
import * as MenuService from '../menu/service.js';
import * as CartService from '../cart/service.js';
import * as CustomerService from '../customer/service.js';
import * as OrderService from '../order/service.js';
import * as ConversationService from '../conversation/service.js';
import * as DeliveryService from '../delivery/service.js';
import * as OrderModificationService from '../order/modifications.js';
import db from '../db/client.js';
import { revalidateItems } from '../order/menuRevalidator.js';
import { formatBDT } from '../common/money.js';
import { MenuItemNotFoundError, ToolError } from '../common/errors.js';
import { config } from '../config.js';
import type { CartItem } from '../cart/types.js';

// ---------- schemas ----------

const AddToCartSchema = z.object({
  menu_item_id: z.string().uuid(),
  quantity: z.number().int().positive(),
  variant_id: z.string().uuid().optional(),
  addon_ids: z.array(z.string().uuid()).optional(),
});

const UpdateCartSchema = z.object({
  menu_item_id: z.string().uuid(),
  variant_id: z.string().uuid().optional(),
  quantity: z.number().int().nonnegative(),
});

const RemoveSchema = z.object({
  menu_item_id: z.string().uuid(),
  variant_id: z.string().uuid().optional(),
});

const SearchSchema = z.object({
  query: z.string().min(1).optional(),
});

const GetItemSchema = z.object({
  item_id: z.string().uuid(),
});

const CheckAvailabilitySchema = z.object({
  item_id: z.string().uuid(),
  variant_id: z.string().uuid().optional(),
  addon_ids: z.array(z.string().uuid()).optional(),
});

const CancelOrderSchema = z.object({
  order_id: z.string().uuid(),
  reason: z.string().min(1).max(500),
});

// Either an explicit order_id, or omit to get the customer's most recent order.
const GetOrderStatusSchema = z.object({
  order_id: z.string().uuid().optional(),
  include_terminal: z.boolean().optional(),
});

const CustomerUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  default_address: z.string().min(1).optional(),
  payment_method: z.string().min(1).optional(),
});

const CreateOrderSchema = z.object({
  confirm: z.literal(true).describe('Must be exactly true. Refuses otherwise.'),
});

// ---------- phase 2 schemas ----------

const GetDeliveryZonesSchema = z.object({});

const SetDeliveryAddressSchema = z.object({
  zone_id: z.string().uuid(),
  line1: z.string().min(1).max(500),
  line2: z.string().min(1).max(500).optional(),
  note_for_rider: z.string().min(1).max(500).optional(),
});

const GetOrderHistorySchema = z.object({
  limit: z.number().int().min(1).max(20).optional(),
  before_iso: z.string().optional(),
  include_terminal: z.boolean().optional(),
});

const ReorderFromHistorySchema = z.object({
  order_id: z.string().uuid(),
  proceed_with: z.enum(['all', 'available_only']).optional(),
});

// modify_order uses a discriminated union so the agent can't accidentally
// pass `phase: 'apply'` without `confirm: true` + `items[]`, and vice versa.
// A plain z.union would silently accept either shape in any order.
const ModifyOrderSchema = z.discriminatedUnion('phase', [
  z.object({
    order_id: z.string().uuid(),
    phase: z.literal('read'),
  }),
  z.object({
    order_id: z.string().uuid(),
    phase: z.literal('apply'),
    confirm: z.literal(true),
    items: z.array(
      z.object({
        menu_item_id: z.string().uuid(),
        name: z.string().min(1),
        quantity: z.number().int().positive(),
        unit_price_paisa: z.number().int().nonnegative().optional(),
        variant_id: z.string().uuid().optional(),
        addon_ids: z.array(z.string().uuid()).optional(),
        addons: z
          .array(
            z.object({
              id: z.string().uuid(),
              name: z.string(),
              price_paisa: z.number().int().nonnegative(),
            }),
          )
          .optional(),
        line_total_paisa: z.number().int().nonnegative().optional(),
      }),
    ),
  }),
]);

const ScheduleOrderSchema = z.object({
  order_id: z.string().uuid(),
  requested_for_iso: z.string().min(1),
});

// Set of tool names gated behind FEATURE_CUSTOMER_ORDER_PHASE2.
// Verified at runTool() boundary BEFORE looking up the handler, so the
// agent sees a stable 'feature_disabled' error rather than 'unknown_tool'.
const PHASE2_TOOLS = new Set([
  'get_delivery_zones',
  'set_delivery_address',
  'get_order_history',
  'reorder_from_history',
  'modify_order',
  'schedule_order',
]);

// ---------- types ----------

export interface AgentContext {
  conversationId: string;
  customerId: string;
  restaurantId: string;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: AgentContext,
) => Promise<string>;

// ---------- helpers ----------

function summaryText(
  cart: CartItem[],
  deliveryFee: number,
  restaurantName: string,
): string {
  const subtotal = cart.reduce((s, i) => s + i.line_total_paisa, 0);
  const total = subtotal + deliveryFee;

  const lines: string[] = ['আপনার অর্ডার:'];
  for (const it of cart) {
    const variant = it.variant_name ? ` (${it.variant_name})` : '';
    const addons = it.addons.length
      ? ' + ' + it.addons.map((a) => a.name).join(', ')
      : '';
    lines.push(`• ${it.name}${variant}${addons} × ${it.quantity} — ${formatBDT(it.line_total_paisa)}`);
  }
  lines.push('');
  lines.push(`Subtotal: ${formatBDT(subtotal)}`);
  lines.push(`Delivery: ${formatBDT(deliveryFee)}`);
  lines.push(`Total: ${formatBDT(total)}`);
  lines.push('');
  lines.push('অর্ডারটি কনফার্ম করবেন? (হ্যাঁ/না)');
  return lines.join('\n');
}

// ---------- tool definitions (Gemini functionDeclarations) ----------

export const toolDefinitions: FunctionDeclaration[] = [
  {
    name: 'search_menu',
    description:
      'Search the menu. Returns up to 10 items with id, name, price (paisa), category. Use when the customer asks for a dish or to see the menu.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search term — Bangla, Banglish, or English. Empty for full menu.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_item_details',
    description:
      'Get full item details including variants (Small/Medium/Large) and add-ons (Extra Cheese, etc).',
    parameters: {
      type: 'object',
      properties: { item_id: { type: 'string', format: 'uuid' } },
      required: ['item_id'],
    },
  },
  {
    name: 'check_item_availability',
    description:
      'Verify a menu item (and optionally a variant / set of addons) is currently orderable. Use before adding to cart if the menu might be stale.',
    parameters: {
      type: 'object',
      properties: {
        item_id: { type: 'string', format: 'uuid' },
        variant_id: { type: 'string', format: 'uuid' },
        addon_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
      },
      required: ['item_id'],
    },
  },
  {
    name: 'add_to_cart',
    description:
      'Add an item to the cart. Prices are server-side; pass item id and quantity. The tool will look up current price and addons.',
    parameters: {
      type: 'object',
      properties: {
        menu_item_id: { type: 'string', format: 'uuid' },
        quantity: { type: 'integer', minimum: 1 },
        variant_id: { type: 'string', format: 'uuid' },
        addon_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
      },
      required: ['menu_item_id', 'quantity'],
    },
  },
  {
    name: 'update_cart_item',
    description: 'Change the quantity of an item already in the cart. Use quantity=0 to remove.',
    parameters: {
      type: 'object',
      properties: {
        menu_item_id: { type: 'string', format: 'uuid' },
        variant_id: { type: 'string', format: 'uuid' },
        quantity: { type: 'integer', minimum: 0 },
      },
      required: ['menu_item_id', 'quantity'],
    },
  },
  {
    name: 'remove_from_cart',
    description: 'Remove an item entirely from the cart.',
    parameters: {
      type: 'object',
      properties: {
        menu_item_id: { type: 'string', format: 'uuid' },
        variant_id: { type: 'string', format: 'uuid' },
      },
      required: ['menu_item_id'],
    },
  },
  {
    name: 'clear_cart',
    description: 'Empty the cart.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'calculate_order_total',
    description: 'Compute subtotal, delivery fee, and total in paisa. Read-only.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'summarize_cart_for_confirmation',
    description:
      'Produce the Bangla order summary text shown to the customer before they confirm. The summary includes all items, prices, delivery fee, and total. Use this BEFORE asking the customer to confirm.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_customer_information',
    description: 'Read the customer profile (name, default address, payment method).',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'update_customer_information',
    description:
      'Update the customer profile. Only pass fields you want to change. Use when the customer provides name, address, or payment method.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        default_address: { type: 'string' },
        payment_method: { type: 'string' },
      },
      required: [],
    },
  },
  {
    name: 'create_order',
    description:
      'Create the confirmed order. ONLY call this after the customer has explicitly said yes/হ্যাঁ to the summary. The "confirm" argument MUST be exactly true. The server re-validates every line and recomputes prices; if anything is invalid this will error.',
    parameters: {
      type: 'object',
      properties: {
        confirm: {
          type: 'boolean',
          description: 'Must be exactly true to create the order. The server rejects false.',
        },
      },
      required: ['confirm'],
    },
  },
  {
    name: 'cancel_order',
    description:
      "Cancel one of the customer's pending or confirmed orders. The order must belong to the current customer; an order that has already been delivered or cancelled cannot be cancelled again. Provide a short Bangla reason like 'ঠিকানা ভুল হয়েছে' or 'বাতিল করতে চাই'.",
    parameters: {
      type: 'object',
      properties: {
        order_id: { type: 'string', format: 'uuid' },
        reason: {
          type: 'string',
          description: 'Short Bangla reason for the cancellation. Required.',
        },
      },
      required: ['order_id', 'reason'],
    },
  },
  {
    name: 'get_order_status',
    description:
      "Look up the status of one of the customer's orders. Pass an order_id to fetch a specific order, or omit order_id to get the customer's most recent order. Returns the order state (pending/confirmed/preparing/ready/out_for_delivery/delivered/cancelled), items, totals, timestamps, and a notifications[] log. Only returns orders owned by the current customer.",
    parameters: {
      type: 'object',
      properties: {
        order_id: {
          type: 'string',
          format: 'uuid',
          description: 'Optional. UUID of the order to look up. If omitted, returns the most recent order.',
        },
        include_terminal: {
          type: 'boolean',
          description:
            "Optional. When omitting order_id, include delivered/cancelled orders. Default false (active only).",
        },
      },
      required: [],
    },
  },
  {
    name: 'get_delivery_zones',
    description:
      'List active delivery zones for the restaurant with name, ETA in minutes, and delivery fee. Call this when the customer wants to set or change their delivery address.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'set_delivery_address',
    description:
      "Save the customer's delivery address (zone + structured line1/line2/note). Returns the saved address and the zone's ETA + fee.",
    parameters: {
      type: 'object',
      properties: {
        zone_id: { type: 'string', format: 'uuid' },
        line1: { type: 'string' },
        line2: { type: 'string' },
        note_for_rider: { type: 'string' },
      },
      required: ['zone_id', 'line1'],
    },
  },
  {
    name: 'get_order_history',
    description:
      "Get the customer's recent orders (most recent first). limit defaults to 5, max 20. include_terminal includes delivered/cancelled (default false — active only).",
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 20 },
        before_iso: { type: 'string', format: 'date-time' },
        include_terminal: { type: 'boolean' },
      },
      required: [],
    },
  },
  {
    name: 'reorder_from_history',
    description:
      "Re-populate the conversation cart from a past order. Re-validates every line against the live menu. Unavailable items come back in the report so the customer can decide. With proceed_with='available_only', the available items are placed in the cart and the customer goes through the normal confirmation flow.",
    parameters: {
      type: 'object',
      properties: {
        order_id: { type: 'string', format: 'uuid' },
        proceed_with: { type: 'string', enum: ['all', 'available_only'] },
      },
      required: ['order_id'],
    },
  },
  {
    name: 'modify_order',
    description:
      "Two-phase modify. phase='read': return current items for the order (use to show the customer). phase='apply': replace the items with the given array; requires confirm=true. Allowed only while order state is pending or confirmed.",
    parameters: {
      type: 'object',
      properties: {
        order_id: { type: 'string', format: 'uuid' },
        phase: { type: 'string', enum: ['read', 'apply'] },
        confirm: { type: 'boolean' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              menu_item_id: { type: 'string', format: 'uuid' },
              name: { type: 'string' },
              quantity: { type: 'integer', minimum: 1 },
              variant_id: { type: 'string', format: 'uuid' },
              addon_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
            },
            required: ['menu_item_id', 'quantity'],
          },
        },
      },
      required: ['order_id', 'phase'],
    },
  },
  {
    name: 'schedule_order',
    description:
      'Schedule an order for a future time (max 7 days out). Sets orders.requested_for; ETA in get_order_status reflects requested_for + zone eta_minutes.',
    parameters: {
      type: 'object',
      properties: {
        order_id: { type: 'string', format: 'uuid' },
        requested_for_iso: { type: 'string', format: 'date-time' },
      },
      required: ['order_id', 'requested_for_iso'],
    },
  },
];

// ---------- handlers ----------

const handlers: Record<string, { schema: z.ZodTypeAny; fn: ToolHandler }> = {
  search_menu: {
    schema: SearchSchema,
    fn: async (args, ctx) => {
      const parsed = SearchSchema.parse(args);
      const results = await MenuService.searchMenu(ctx.restaurantId, parsed.query, 10);
      return JSON.stringify({ items: results });
    },
  },
  get_item_details: {
    schema: GetItemSchema,
    fn: async (args, ctx) => {
      const parsed = GetItemSchema.parse(args);
      const details = await MenuService.getItemDetails(ctx.restaurantId, parsed.item_id);
      return JSON.stringify(details);
    },
  },
  add_to_cart: {
    schema: AddToCartSchema,
    fn: async (args, ctx) => {
      const parsed = AddToCartSchema.parse(args);
      const current = await ConversationService.getCart(ctx.conversationId);
      const newLine = await CartService.__test.buildSnapshotLine(ctx.restaurantId, parsed);
      const merged = CartService.addItem(current, newLine);
      await ConversationService.setCart(ctx.conversationId, merged);
      await ConversationService.transitionTo(ctx.conversationId, 'ordering');
      return JSON.stringify({
        added: newLine,
        cart_total_items: merged.length,
        cart_subtotal_paisa: merged.reduce((s, i) => s + i.line_total_paisa, 0),
      });
    },
  },
  update_cart_item: {
    schema: UpdateCartSchema,
    fn: async (args, ctx) => {
      const parsed = UpdateCartSchema.parse(args);
      const current = await ConversationService.getCart(ctx.conversationId);
      const next = CartService.updateQuantity(current, parsed);
      await ConversationService.setCart(ctx.conversationId, next);
      return JSON.stringify({
        cart_total_items: next.length,
        cart_subtotal_paisa: next.reduce((s, i) => s + i.line_total_paisa, 0),
      });
    },
  },
  remove_from_cart: {
    schema: RemoveSchema,
    fn: async (args, ctx) => {
      const parsed = RemoveSchema.parse(args);
      const current = await ConversationService.getCart(ctx.conversationId);
      const next = CartService.removeItem(current, parsed.menu_item_id, parsed.variant_id);
      await ConversationService.setCart(ctx.conversationId, next);
      return JSON.stringify({ cart_total_items: next.length });
    },
  },
  clear_cart: {
    schema: z.object({}),
    fn: async (_args, ctx) => {
      await ConversationService.clearCart(ctx.conversationId);
      await ConversationService.transitionTo(ctx.conversationId, 'idle');
      return JSON.stringify({ cleared: true });
    },
  },
  calculate_order_total: {
    schema: z.object({}),
    fn: async (_args, ctx) => {
      const items = await ConversationService.getCart(ctx.conversationId);
      const totals = CartService.snapshot(items, config.RESTAURANT_DEFAULT_DELIVERY_FEE_PAISA);
      return JSON.stringify({
        subtotal_paisa: totals.subtotal_paisa,
        delivery_fee_paisa: totals.delivery_fee_paisa,
        total_paisa: totals.total_paisa,
      });
    },
  },
  summarize_cart_for_confirmation: {
    schema: z.object({}),
    fn: async (_args, ctx) => {
      const items = await ConversationService.getCart(ctx.conversationId);
      if (items.length === 0) {
        throw new ToolError(
          'cart_empty',
          'কার্ট খালি, কিছু যোগ করুন।',
          'cannot summarize empty cart',
        );
      }
      // Phase 2: use the customer's saved delivery address zone for the fee,
      // so the summary matches what create_order will actually charge.
      const addr = await DeliveryService.getDefaultAddress(ctx.customerId);
      const fee = addr
        ? (await DeliveryService.getZone(addr.zone_id))?.delivery_fee_paisa ??
          config.RESTAURANT_DEFAULT_DELIVERY_FEE_PAISA
        : config.RESTAURANT_DEFAULT_DELIVERY_FEE_PAISA;
      const text = summaryText(items, fee, config.RESTAURANT_NAME);
      await ConversationService.transitionTo(ctx.conversationId, 'awaiting_confirmation');
      return JSON.stringify({ summary: text });
    },
  },
  get_customer_information: {
    schema: z.object({}),
    fn: async (_args, ctx) => {
      const c = await CustomerService.getById(ctx.customerId);
      return JSON.stringify(c);
    },
  },
  update_customer_information: {
    schema: CustomerUpdateSchema,
    fn: async (args, ctx) => {
      const parsed = CustomerUpdateSchema.parse(args);
      const c = await CustomerService.update(ctx.customerId, parsed);
      return JSON.stringify(c);
    },
  },
  create_order: {
    schema: CreateOrderSchema,
    fn: async (args, ctx) => {
      const parsed = CreateOrderSchema.parse(args);
      if (parsed.confirm !== true) {
        throw new ToolError(
          'not_confirmed',
          'অর্ডার কনফার্ম করা হয়নি।',
          'create_order requires confirm: true',
        );
      }
      const items = await ConversationService.getCart(ctx.conversationId);
      CartService.assertNonEmpty(items);
      const customer = await CustomerService.getById(ctx.customerId);

      // Phase 2: pick fee + delivery address + zone from the customer's saved
      // structured address when present. Falls back to the legacy free-text
      // default_address + flat delivery fee for customers who haven't set one.
      const addr = await DeliveryService.getDefaultAddress(ctx.customerId);
      const fee = addr
        ? (await DeliveryService.getZone(addr.zone_id))?.delivery_fee_paisa ??
          config.RESTAURANT_DEFAULT_DELIVERY_FEE_PAISA
        : config.RESTAURANT_DEFAULT_DELIVERY_FEE_PAISA;

      const order = await OrderService.confirm({
        restaurant_id: ctx.restaurantId,
        customer_id: ctx.customerId,
        conversation_id: ctx.conversationId,
        items,
        delivery_fee_paisa: fee,
        delivery_address: addr?.line1 ?? customer.default_address,
        delivery_zone_id: addr?.zone_id ?? null,
        payment_method: customer.payment_method,
      });

      // Clear cart + return to idle
      await ConversationService.clearCart(ctx.conversationId);
      await ConversationService.transitionTo(ctx.conversationId, 'idle');

      return JSON.stringify({
        order_id: order.id,
        state: order.state,
        total_paisa: order.total_paisa,
        total_display: formatBDT(order.total_paisa),
      });
    },
  },
  check_item_availability: {
    schema: CheckAvailabilitySchema,
    fn: async (args, ctx) => {
      const parsed = CheckAvailabilitySchema.parse(args);
      const result = await MenuService.checkAvailability(ctx.restaurantId, parsed.item_id, {
        variantId: parsed.variant_id,
        addonIds: parsed.addon_ids,
      });
      return JSON.stringify(result);
    },
  },
  cancel_order: {
    schema: CancelOrderSchema,
    fn: async (args, ctx) => {
      const parsed = CancelOrderSchema.parse(args);
      // Verify ownership before any state change so we don't leak order
      // existence to other customers.
      const existing = await OrderService.getById(parsed.order_id);
      if (existing.customer_id !== ctx.customerId) {
        throw new ToolError(
          'order_not_found',
          'অর্ডার খুঁজে পাওয়া যায়নি।',
          `cancel_order: order ${parsed.order_id} not owned by customer ${ctx.customerId}`,
        );
      }
      const order = await OrderService.transition(
        parsed.order_id,
        'cancelled',
        'customer',
        parsed.reason,
      );
      return JSON.stringify({
        order_id: order.id,
        state: order.state,
        cancelled_at: order.cancelled_at,
        cancel_reason: order.cancel_reason,
      });
    },
  },
  get_order_status: {
    schema: GetOrderStatusSchema,
    fn: async (args, ctx) => {
      const parsed = GetOrderStatusSchema.parse(args);
      let order;
      if (parsed.order_id) {
        try {
          order = await OrderService.getById(parsed.order_id);
        } catch {
          // Treat not-found and ownership mismatch identically so we never
          // leak existence of other customers' orders.
          throw new ToolError(
            'order_not_found',
            'অর্ডার খুঁজে পাওয়া যায়নি।',
            `get_order_status: order ${parsed.order_id} not found`,
          );
        }
        if (order.customer_id !== ctx.customerId) {
          throw new ToolError(
            'order_not_found',
            'অর্ডার খুঁজে পাওয়া যায়নি।',
            `get_order_status: order ${parsed.order_id} not owned by customer ${ctx.customerId}`,
          );
        }
      } else {
        // Phase 2: use the lightweight history view so we can honour
        // include_terminal. Default is to exclude delivered/cancelled so the
        // customer's "active" order surfaces first.
        const recent = await OrderService.listHistoryByCustomer(ctx.customerId, {
          limit: 1,
          beforeIso: null,
          includeTerminal: parsed.include_terminal ?? false,
        });
        const head = recent[0];
        if (!head) {
          throw new ToolError(
            'order_not_found',
            'আপনার কোনো অর্ডার নেই।',
            `get_order_status: customer ${ctx.customerId} has no orders`,
          );
        }
        // Hydrate to the full Order shape so the response below stays
        // backward-compatible with anything that depends on `items[]`.
        order = await OrderService.getById(head.id);
      }
      // Phase 2: always include a notifications log so the customer can see
      // when each state-change WhatsApp was sent (and when Meta confirmed
      // delivery). Cheap read; no need to batch.
      const notif = await db.query<{
        to_state: string;
        sent_at: string;
        delivered_at: string | null;
      }>(
        `SELECT to_state, sent_at, delivered_at FROM order_status_notifications
         WHERE order_id = $1 ORDER BY sent_at ASC`,
        [order.id],
      );
      return JSON.stringify({
        order_id: order.id,
        state: order.state,
        items: order.items,
        subtotal_paisa: order.subtotal_paisa,
        delivery_fee_paisa: order.delivery_fee_paisa,
        total_paisa: order.total_paisa,
        total_display: formatBDT(order.total_paisa),
        delivery_address: order.delivery_address,
        delivery_zone_id: order.delivery_zone_id,
        requested_for: order.requested_for,
        payment_method: order.payment_method,
        confirmed_at: order.confirmed_at,
        cancelled_at: order.cancelled_at,
        cancel_reason: order.cancel_reason,
        created_at: order.created_at,
        updated_at: order.updated_at,
        notifications: notif,
      });
    },
  },

  // ---------- phase 2 handlers ----------

  get_delivery_zones: {
    schema: GetDeliveryZonesSchema,
    fn: async (_args, ctx) => {
      const zones = await DeliveryService.listActiveZones(ctx.restaurantId);
      return JSON.stringify({ zones });
    },
  },

  set_delivery_address: {
    schema: SetDeliveryAddressSchema,
    fn: async (args, ctx) => {
      const parsed = SetDeliveryAddressSchema.parse(args);
      const address = await DeliveryService.setAddress(ctx.customerId, parsed);
      const zone = await DeliveryService.getZone(address.zone_id);
      return JSON.stringify({
        address,
        eta_minutes: zone?.eta_minutes ?? null,
        delivery_fee_paisa: zone?.delivery_fee_paisa ?? null,
      });
    },
  },

  get_order_history: {
    schema: GetOrderHistorySchema,
    fn: async (args, ctx) => {
      const parsed = GetOrderHistorySchema.parse(args);
      const orders = await OrderService.listHistoryByCustomer(ctx.customerId, {
        limit: parsed.limit ?? 5,
        beforeIso: parsed.before_iso ?? null,
        includeTerminal: parsed.include_terminal ?? false,
      });
      if (orders.length === 0) {
        throw new ToolError(
          'no_history',
          'আপনার কোনো পুরাতন অর্ডার নেই।',
          `customer ${ctx.customerId} has no orders`,
        );
      }
      return JSON.stringify({ orders });
    },
  },

  reorder_from_history: {
    schema: ReorderFromHistorySchema,
    fn: async (args, ctx) => {
      const parsed = ReorderFromHistorySchema.parse(args);
      const order = await OrderService.getById(parsed.order_id).catch(() => null);
      if (!order || order.customer_id !== ctx.customerId) {
        // never leak existence
        throw new ToolError(
          'order_not_found',
          'অর্ডার খুঁজে পাওয়া যায়নি।',
          `reorder_from_history: order ${parsed.order_id} not found`,
        );
      }
      // Revalidate every line independently against the live menu so the
      // customer can see which items are still orderable. We pass
      // unit_price_paisa=0 + line_total_paisa=0 because revalidateItems
      // re-computes from the menu — we just want it to throw on missing
      // or unavailable items.
      const available: typeof order.items = [];
      const unavailable: Array<{ name: string; reason: string }> = [];
      for (const line of order.items) {
        try {
          const revalidated = await revalidateItems(ctx.restaurantId, [
            { ...line, unit_price_paisa: 0, line_total_paisa: 0 },
          ]);
          available.push(revalidated[0]!);
        } catch (err) {
          // Surface the menu-side reason (item_not_found vs unavailable) but
          // never the raw exception text.
          const code = (err as { code?: string } | null)?.code ?? 'unavailable';
          unavailable.push({ name: line.name, reason: code });
        }
      }
      if (available.length === 0) {
        throw new ToolError(
          'nothing_available',
          'কোনো আইটেমই এখন পাওয়া যাচ্ছে না।',
          'nothing available to reorder',
        );
      }
      // Partial-failure path: ask the customer before mutating the cart.
      if (unavailable.length > 0 && parsed.proceed_with !== 'available_only') {
        return JSON.stringify({
          available,
          unavailable,
          cart_populated: false,
        });
      }
      await ConversationService.setCart(ctx.conversationId, available);
      await ConversationService.transitionTo(ctx.conversationId, 'ordering');
      return JSON.stringify({
        available,
        unavailable,
        cart_populated: true,
      });
    },
  },

  modify_order: {
    schema: ModifyOrderSchema,
    fn: async (args, ctx) => {
      const parsed = ModifyOrderSchema.parse(args);
      if (parsed.phase === 'read') {
        const items = await OrderModificationService.getCurrentItems(
          parsed.order_id,
          ctx.customerId,
        );
        await ConversationService.transitionTo(
          ctx.conversationId,
          'awaiting_modify_confirmation',
        );
        return JSON.stringify({ current_items: items });
      }
      // phase === 'apply' — schema enforces confirm:true + items[].
      const result = await OrderModificationService.applyModification({
        orderId: parsed.order_id,
        customerId: ctx.customerId,
        newItems: parsed.items as never,
      });
      await ConversationService.transitionTo(ctx.conversationId, 'idle');
      return JSON.stringify({
        order_id: result.order.id,
        items: result.order.items,
        total_paisa: result.order.total_paisa,
        total_display: formatBDT(result.order.total_paisa),
        modified_at: result.modification.created_at,
      });
    },
  },

  schedule_order: {
    schema: ScheduleOrderSchema,
    fn: async (args, ctx) => {
      const parsed = ScheduleOrderSchema.parse(args);
      const requested = new Date(parsed.requested_for_iso);
      const now = new Date();
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      if (
        Number.isNaN(requested.getTime()) ||
        requested <= now ||
        requested.getTime() - now.getTime() > sevenDaysMs
      ) {
        throw new ToolError(
          'bad_schedule_window',
          'সময়টি সঠিক নয়। আগামী ৭ দিনের মধ্যে একটি সময় দিন।',
          `schedule_order: bad window ${parsed.requested_for_iso}`,
        );
      }
      const order = await OrderService.getById(parsed.order_id).catch(() => null);
      if (!order || order.customer_id !== ctx.customerId) {
        throw new ToolError(
          'order_not_found',
          'অর্ডার খুঁজে পাওয়া যায়নি।',
          `schedule_order: order ${parsed.order_id} not found`,
        );
      }
      if (!['pending', 'confirmed', 'preparing'].includes(order.state)) {
        throw new ToolError(
          'order_not_modifiable',
          'এই অর্ডারটি আর শিডিউল করা যাবে নে।',
          `schedule_order: state ${order.state} cannot be scheduled`,
        );
      }
      await db.query(
        `UPDATE orders SET requested_for = $1, updated_at = now() WHERE id = $2`,
        [requested.toISOString(), parsed.order_id],
      );
      // Compute eta from the customer's saved address zone; fall back to a
      // flat 30 min if the customer hasn't saved a structured address yet.
      const addr = await DeliveryService.getDefaultAddress(ctx.customerId);
      const etaMinutes = addr
        ? (await DeliveryService.getZone(addr.zone_id))?.eta_minutes ?? 30
        : 30;
      const eta = new Date(requested.getTime() + etaMinutes * 60 * 1000);
      return JSON.stringify({
        order_id: parsed.order_id,
        requested_for: requested.toISOString(),
        eta_minutes: etaMinutes,
        eta_iso: eta.toISOString(),
      });
    },
  },
};

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: AgentContext,
): Promise<string> {
  // Feature flag gate: phase 2 tools throw a stable 'feature_disabled' error
  // BEFORE the handler lookup, so callers don't see 'unknown_tool' for
  // tools that exist in the registry but aren't enabled yet.
  if (PHASE2_TOOLS.has(name) && !config.FEATURE_CUSTOMER_ORDER_PHASE2) {
    throw new ToolError(
      'feature_disabled',
      'এই ফিচারটি এখন বন্ধ আছে।',
      `tool ${name} is gated by FEATURE_CUSTOMER_ORDER_PHASE2`,
    );
  }
  const def = handlers[name];
  if (!def) {
    throw new ToolError('unknown_tool', 'টুল খুঁজে পাওয়া যায়নি।', `unknown tool: ${name}`);
  }
  return def.fn(args, ctx);
}

export const _schemas = {
  AddToCartSchema,
  UpdateCartSchema,
  RemoveSchema,
  SearchSchema,
  GetItemSchema,
  CustomerUpdateSchema,
  CreateOrderSchema,
  CheckAvailabilitySchema,
  CancelOrderSchema,
  GetOrderStatusSchema,
  GetDeliveryZonesSchema,
  SetDeliveryAddressSchema,
  GetOrderHistorySchema,
  ReorderFromHistorySchema,
  ModifyOrderSchema,
  ScheduleOrderSchema,
};

export const _handlers = handlers;