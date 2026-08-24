import { z } from 'zod';
import type { FunctionDeclaration } from './gemini.js';
import * as MenuService from '../menu/service.js';
import * as CartService from '../cart/service.js';
import * as CustomerService from '../customer/service.js';
import * as OrderService from '../order/service.js';
import * as ConversationService from '../conversation/service.js';
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
});

const CustomerUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  default_address: z.string().min(1).optional(),
  payment_method: z.string().min(1).optional(),
});

const CreateOrderSchema = z.object({
  confirm: z.literal(true).describe('Must be exactly true. Refuses otherwise.'),
});

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
      "Look up the status of one of the customer's orders. Pass an order_id to fetch a specific order, or omit order_id to get the customer's most recent order. Returns the order state (pending/confirmed/preparing/ready/out_for_delivery/delivered/cancelled), items, totals, and timestamps. Only returns orders owned by the current customer.",
    parameters: {
      type: 'object',
      properties: {
        order_id: {
          type: 'string',
          format: 'uuid',
          description: 'Optional. UUID of the order to look up. If omitted, returns the most recent order.',
        },
      },
      required: [],
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
      const text = summaryText(items, config.RESTAURANT_DEFAULT_DELIVERY_FEE_PAISA, config.RESTAURANT_NAME);
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

      const order = await OrderService.confirm({
        restaurant_id: ctx.restaurantId,
        customer_id: ctx.customerId,
        conversation_id: ctx.conversationId,
        items,
        delivery_fee_paisa: config.RESTAURANT_DEFAULT_DELIVERY_FEE_PAISA,
        delivery_address: customer.default_address,
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
        const recent = await OrderService.listByCustomer(ctx.customerId);
        order = recent[0];
        if (!order) {
          throw new ToolError(
            'order_not_found',
            'আপনার কোনো অর্ডার নেই।',
            `get_order_status: customer ${ctx.customerId} has no orders`,
          );
        }
      }
      return JSON.stringify({
        order_id: order.id,
        state: order.state,
        items: order.items,
        subtotal_paisa: order.subtotal_paisa,
        delivery_fee_paisa: order.delivery_fee_paisa,
        total_paisa: order.total_paisa,
        total_display: formatBDT(order.total_paisa),
        delivery_address: order.delivery_address,
        payment_method: order.payment_method,
        confirmed_at: order.confirmed_at,
        cancelled_at: order.cancelled_at,
        cancel_reason: order.cancel_reason,
        created_at: order.created_at,
        updated_at: order.updated_at,
      });
    },
  },
};

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: AgentContext,
): Promise<string> {
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
};

export const _handlers = handlers;