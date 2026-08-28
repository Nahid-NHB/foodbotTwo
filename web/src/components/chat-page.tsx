"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  Menu as MenuIcon,
  Send,
  ShoppingCart,
  Trash2,
  User,
  Wrench,
  X,
} from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { detectQuickReplies, type QuickReply } from "@/lib/quickReplies";
import { Markdown } from "@/lib/markdown";
import { cn, formatBDT } from "@/lib/utils";
import { LatestAddress } from "@/components/LatestAddress";
import { RecentOrders } from "@/components/RecentOrders";
import { TrackLatest } from "@/components/TrackLatest";
import { ModifyModal, type ModifyItem } from "@/components/ModifyModal";

// ---------- types ----------

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  result: string;
}

interface CartItem {
  name: string;
  quantity: number;
  line_total_paisa: number;
  variant_name?: string | null;
  addons?: Array<{ name: string }>;
}

interface Message {
  id: string;
  role: "user" | "agent";
  text: string;
  toolCalls?: ToolCall[];
  cart?: CartItem[];
  tokensUsed?: number;
  pending?: boolean;
  error?: boolean;
  ts: number;
}

interface ChatResponse {
  reply: string;
  toolCalls: ToolCall[];
  cart: CartItem[];
  tokensUsed: number;
}

// ---------- helpers ----------

const STORAGE_KEY = "foodbot-test-chat-v2";
const DEFAULT_PHONE = "+8801700009999";

const SUGGESTIONS = [
  "আসসালামু আলাইকুম",
  "menu dekhao",
  "2 ta chicken burger den",
  "ঠিকানা সেভ করো",
];

function loadFromStorage(): { phone: string; messages: Message[] } {
  if (typeof window === "undefined") return { phone: DEFAULT_PHONE, messages: [] };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { phone: DEFAULT_PHONE, messages: [] };
    const parsed = JSON.parse(raw) as {
      phone?: string;
      messages?: Array<Omit<Message, "ts"> & { ts?: number }>;
    };
    return {
      phone: parsed.phone ?? DEFAULT_PHONE,
      messages: (parsed.messages ?? []).map((m, i) => ({
        ...m,
        ts: typeof m.ts === "number" ? m.ts : Date.now() - (parsed.messages!.length - i) * 1000,
      })),
    };
  } catch {
    return { phone: DEFAULT_PHONE, messages: [] };
  }
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function isToolErrorResult(result: string): boolean {
  try {
    const parsed: unknown = JSON.parse(result);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      return typeof (parsed as { error: unknown }).error === "string";
    }
  } catch {
    // fall through
  }
  return false;
}

/**
 * Try to extract an order id from a tool-call result. Used so the
 * `TrackLatest` card can lock onto the order that the agent just looked up.
 * Looks for an `id` field either at the root, in `order`, or in the first
 * element of `orders`.
 */
function extractOrderIdFromResult(result: string): string | null {
  try {
    const parsed: unknown = JSON.parse(result);
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj["id"] === "string") return obj["id"];
    if (obj["order"] && typeof obj["order"] === "object") {
      const inner = obj["order"] as Record<string, unknown>;
      if (typeof inner["id"] === "string") return inner["id"];
    }
    if (Array.isArray(obj["orders"]) && obj["orders"].length > 0) {
      const first = obj["orders"][0] as Record<string, unknown> | undefined;
      if (first && typeof first["id"] === "string") return first["id"];
    }
  } catch {
    // ignore
  }
  return null;
}

type ConnStatus = "idle" | "sending" | "error";

export function ChatPage() {
  const [phone, setPhone] = useState(DEFAULT_PHONE);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [sending, setSending] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [latestOrderId, setLatestOrderId] = useState<string | null>(null);
  const [modifyOpen, setModifyOpen] = useState(false);
  const [modifyItems, setModifyItems] = useState<ModifyItem[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Restore from localStorage on mount (per-browser).
  useEffect(() => {
    const saved = loadFromStorage();
    setPhone(saved.phone);
    setMessages(saved.messages);
  }, []);

  // Persist to localStorage whenever phone or messages change.
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ phone, messages }));
  }, [phone, messages]);

  // Auto-scroll on new messages and when streaming completes.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;

      const now = Date.now();
      const userMsg: Message = {
        id: `user-${now}`,
        role: "user",
        text: trimmed,
        ts: now,
      };
      const pendingMsg: Message = {
        id: `agent-${now}`,
        role: "agent",
        text: "",
        pending: true,
        ts: now,
      };
      setMessages((m) => [...m, userMsg, pendingMsg]);
      setDraft("");
      setSending(true);
      setLastError(null);

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone, userText: trimmed }),
        });
        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`HTTP ${res.status}: ${errText}`);
        }
        const data: ChatResponse = await res.json();
        setMessages((m) =>
          m.map((msg) =>
            msg.id === pendingMsg.id
              ? {
                  ...msg,
                  pending: false,
                  text: data.reply,
                  toolCalls: data.toolCalls,
                  cart: data.cart,
                  tokensUsed: data.tokensUsed,
                  ts: Date.now(),
                }
              : msg,
          ),
        );

        // If the agent just looked up an order, lock the TrackLatest card
        // onto it. Prefer get_order_status; fall back to get_order_history.
        for (const tc of data.toolCalls) {
          const id = extractOrderIdFromResult(tc.result);
          if (id && (tc.name === "get_order_status" || tc.name === "get_order_history")) {
            setLatestOrderId(id);
            break;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setLastError(message);
        setMessages((m) =>
          m.map((msg) =>
            msg.id === pendingMsg.id
              ? {
                  ...msg,
                  pending: false,
                  error: true,
                  text: message,
                  ts: Date.now(),
                }
              : msg,
          ),
        );
      } finally {
        setSending(false);
      }
    },
    [phone, sending],
  );

  function onDraftKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    // Enter sends, Shift+Enter would be newline (but our input is single-line,
    // so just Enter; we keep the modifier check for future-proofing).
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(draft);
    }
  }

  function clearChat() {
    if (messages.length === 0) return;
    if (!confirm("Clear this chat? The customer and order history stay in the DB.")) return;
    setMessages([]);
    setLastError(null);
  }

  // Reorder — fire a Bangla message into the existing chat input. The agent
  // handles `get_order_history` lookup + cart re-population.
  const handleReorder = useCallback(
    (orderId: string) => {
      void send(`আগেরটাই আবার দিন #${orderId}`);
    },
    [send],
  );

  // Open the modify modal pre-populated with the current cart lines. The
  // cart carries enough info (name, quantity, line_total) but no menu_item_id,
  // so we derive a stable pseudo-id from the name. The agent's actual
  // modify_order tool matches by name, so this is safe for the UI demo.
  function openModify() {
    if (latestCart.length === 0) return;
    setModifyItems(
      latestCart.map((line, idx) => {
        const unitPaisa = line.quantity > 0 ? Math.round(line.line_total_paisa / line.quantity) : 0;
        return {
          menu_item_id: line.name || `item-${idx}`,
          name: line.name,
          quantity: line.quantity,
          unit_price_paisa: unitPaisa,
        };
      }),
    );
    setModifyOpen(true);
  }

  // Apply the modify modal — turn the edited items into a Bangla message
  // and post it. Quantities of 0 become "বাদ দিন" (remove).
  const handleApplyModify = useCallback(
    (items: { menu_item_id: string; quantity: number }[]) => {
      const lines = items
        .map((i) => {
          const original = modifyItems.find((m) => m.menu_item_id === i.menu_item_id);
          if (!original) return null;
          if (i.quantity === 0) return `${original.name} বাদ দিন`;
          if (i.quantity !== original.quantity) {
            return `${original.name} ${original.quantity} থেকে ${i.quantity} করুন`;
          }
          return null;
        })
        .filter((s): s is string => Boolean(s));
      setModifyOpen(false);
      if (lines.length === 0) return;
      void send(lines.join(", "));
    },
    [modifyItems, send],
  );

  // Pick the latest cart snapshot from the most recent agent message.
  const latestCart = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "agent" && messages[i]!.cart) return messages[i]!.cart!;
    }
    return [];
  }, [messages]);

  // Pull every tool call from every message, newest first.
  const allToolCalls = useMemo(() => {
    const out: Array<ToolCall & { key: string; ts: number; error: boolean }> = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      for (let j = 0; j < (m.toolCalls ?? []).length; j++) {
        const tc = m.toolCalls![j]!;
        out.push({
          ...tc,
          key: `${m.id}-${j}`,
          ts: m.ts,
          error: isToolErrorResult(tc.result),
        });
      }
    }
    return out;
  }, [messages]);

  const cartTotal = useMemo(
    () => latestCart.reduce((sum, l) => sum + l.line_total_paisa, 0),
    [latestCart],
  );

  const connStatus: ConnStatus = sending ? "sending" : lastError ? "error" : "idle";

  return (
    <div className="grid h-dvh grid-cols-1 lg:grid-cols-[1fr_360px]">
      {/* Main chat panel */}
      <div className="flex flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-background)]/80 px-4 py-3 backdrop-blur sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <Avatar>
              <AvatarFallback>FB</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <div className="truncate text-sm font-semibold">FoodBot Test Chat</div>
                <ConnBadge status={connStatus} />
              </div>
              <div className="truncate text-xs text-[var(--color-muted-foreground)]">
                Drives the agent via <code className="font-mono">POST /api/chat</code>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="h-8 w-40 text-xs sm:w-44"
              placeholder="+8801700009999"
              aria-label="phone"
              spellCheck={false}
            />
            <Button
              variant="ghost"
              size="icon"
              onClick={clearChat}
              aria-label="clear chat"
              disabled={messages.length === 0}
              title="Clear chat"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setCartOpen(true)}
              aria-label="open cart"
              className="lg:hidden"
              title="Cart"
            >
              <div className="relative">
                <ShoppingCart className="h-4 w-4" />
                {latestCart.length > 0 && (
                  <span className="absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-primary)] px-1 text-[10px] font-semibold text-[var(--color-primary-foreground)]">
                    {latestCart.length}
                  </span>
                )}
              </div>
            </Button>
          </div>
        </header>

        <ScrollArea className="flex-1">
          <div
            ref={scrollRef}
            className="space-y-5 p-4 sm:p-6"
            aria-live="polite"
            aria-relevant="additions text"
            role="log"
            aria-label="chat transcript"
          >
            {messages.length === 0 && (
              <EmptyState onPick={(s) => void send(s)} />
            )}
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} onPickReply={(s) => void send(s)} />
            ))}
          </div>
        </ScrollArea>

        <form
          className="flex items-center gap-2 border-t border-[var(--color-border)] bg-[var(--color-background)]/80 p-3 backdrop-blur sm:p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void send(draft);
          }}
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onDraftKeyDown}
            placeholder="Type a message in Bangla or English…  (Enter to send)"
            disabled={sending}
            autoFocus
            maxLength={2000}
            aria-label="message"
          />
          <Button
            type="submit"
            size="icon"
            disabled={sending || !draft.trim()}
            aria-label="send"
            title="Send (Enter)"
          >
            {sending ? <Spinner size="sm" /> : <Send className="h-4 w-4" />}
          </Button>
        </form>
      </div>

      {/* Desktop sidebar */}
      <aside className="hidden flex-col gap-4 overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-muted)]/30 p-4 lg:flex">
        <LatestAddress phone={phone} />
        <TrackLatest phone={phone} orderId={latestOrderId} />
        <RecentOrders phone={phone} onReorder={handleReorder} />
        <CartPanel cart={latestCart} totalPaisa={cartTotal} onModify={openModify} />
        <ToolCallsPanel calls={allToolCalls} />
      </aside>

      {/* Mobile cart drawer */}
      {cartOpen && (
        <div
          className="fixed inset-0 z-50 lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="cart and tool calls"
        >
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label="close cart"
            onClick={() => setCartOpen(false)}
          />
          <div className="absolute inset-y-0 right-0 flex w-full max-w-sm flex-col gap-4 overflow-y-auto bg-[var(--color-background)] p-4 shadow-xl">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">Cart & tool calls</div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setCartOpen(false)}
                aria-label="close"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <LatestAddress phone={phone} />
            <TrackLatest phone={phone} orderId={latestOrderId} />
            <RecentOrders phone={phone} onReorder={handleReorder} />
            <CartPanel cart={latestCart} totalPaisa={cartTotal} onModify={openModify} />
            <ToolCallsPanel calls={allToolCalls} />
          </div>
        </div>
      )}

      <ModifyModal
        open={modifyOpen}
        onClose={() => setModifyOpen(false)}
        items={modifyItems}
        onApply={handleApplyModify}
      />
    </div>
  );
}

// ---------- subcomponents ----------

function ConnBadge({ status }: { status: ConnStatus }) {
  if (status === "sending") {
    return (
      <Badge className="gap-1 border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300">
        <Spinner size="sm" className="h-2.5 w-2.5 border-[1.5px]" /> sending
      </Badge>
    );
  }
  if (status === "error") {
    return (
      <Badge className="gap-1 border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
        <CircleAlert className="h-3 w-3" /> error
      </Badge>
    );
  }
  return (
    <Badge className="gap-1 border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
      <Check className="h-3 w-3" /> idle
    </Badge>
  );
}

function EmptyState({ onPick }: { onPick: (s: string) => void }) {
  return (
    <div className="mx-auto max-w-md space-y-4 rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-card)]/50 p-6 text-center sm:p-8">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-primary)] text-[var(--color-primary-foreground)]">
        <Bot className="h-6 w-6" />
      </div>
      <div className="space-y-1">
        <div className="text-sm font-semibold">Start a conversation</div>
        <div className="text-xs text-[var(--color-muted-foreground)]">
          Pick a starter or type your own — replies stream here.
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className="rounded-full border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-1 text-xs transition-colors hover:bg-[var(--color-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  onPickReply,
}: {
  message: Message;
  onPickReply: (s: string) => void;
}) {
  const isUser = message.role === "user";
  const quickReplies: QuickReply[] | null =
    !isUser && !message.pending && !message.error ? detectQuickReplies(message.text) : null;

  return (
    <div className={cn("flex gap-2.5 sm:gap-3", isUser ? "justify-end" : "justify-start")}>
      {!isUser && (
        <Avatar className="h-7 w-7 sm:h-8 sm:w-8">
          <AvatarFallback className="bg-[var(--color-primary)] text-[var(--color-primary-foreground)]">
            <Bot className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
          </AvatarFallback>
        </Avatar>
      )}
      <div className={cn("flex max-w-[85%] flex-col gap-1.5 sm:max-w-[75%]", isUser ? "items-end" : "items-start")}>
        <div
          className={cn(
            "rounded-2xl px-4 py-2.5 text-sm shadow-sm",
            isUser
              ? "rounded-br-md bg-[var(--color-primary)] text-[var(--color-primary-foreground)]"
              : "rounded-bl-md bg-[var(--color-muted)] text-[var(--color-foreground)]",
            message.error && "border border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200",
          )}
        >
          {message.pending ? (
            <span className="inline-flex items-center gap-2 text-[var(--color-muted-foreground)]">
              <Spinner size="sm" />
              <span>thinking…</span>
            </span>
          ) : isUser ? (
            <span className="whitespace-pre-wrap">{message.text}</span>
          ) : (
            <Markdown source={message.text} />
          )}
        </div>

        {/* Quick replies for yes/no questions */}
        {quickReplies && (
          <div className="flex flex-wrap gap-1.5">
            {quickReplies.map((qr) => (
              <button
                key={qr.label}
                type="button"
                onClick={() => onPickReply(qr.send)}
                className="rounded-full border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-1 text-xs font-medium transition-colors hover:bg-[var(--color-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
              >
                {qr.label}
              </button>
            ))}
          </div>
        )}

        {/* Tool calls (only for agent messages) */}
        {!isUser && !message.pending && (message.toolCalls?.length ?? 0) > 0 && (
          <div className="w-full space-y-1">
            {message.toolCalls!.map((tc, i) => (
              <ToolCallEntry key={i} tc={tc} compact />
            ))}
          </div>
        )}

        {/* Meta row: time + token count */}
        <div className="flex items-center gap-2 text-[10px] text-[var(--color-muted-foreground)]">
          <time dateTime={new Date(message.ts).toISOString()} title={new Date(message.ts).toLocaleString()}>
            {timeAgo(message.ts)}
          </time>
          {!isUser && !message.pending && message.tokensUsed !== undefined && message.tokensUsed > 0 && (
            <>
              <span aria-hidden>·</span>
              <span>{message.tokensUsed} tokens</span>
            </>
          )}
          {!isUser && !message.pending && (message.toolCalls?.length ?? 0) > 0 && (
            <>
              <span aria-hidden>·</span>
              <span>
                {message.toolCalls!.length} tool call{message.toolCalls!.length === 1 ? "" : "s"}
              </span>
            </>
          )}
        </div>
      </div>
      {isUser && (
        <Avatar className="h-7 w-7 sm:h-8 sm:w-8">
          <AvatarFallback className="bg-[var(--color-secondary)]">
            <User className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
          </AvatarFallback>
        </Avatar>
      )}
    </div>
  );
}

function ToolCallEntry({
  tc,
  compact = false,
}: {
  tc: ToolCall;
  compact?: boolean;
}) {
  const error = isToolErrorResult(tc.result);
  let parsedResult: unknown = tc.result;
  try {
    parsedResult = JSON.parse(tc.result);
  } catch {
    // keep as string
  }

  return (
    <Collapsible>
      <CollapsibleTrigger
        className={cn(
          "group flex w-full items-center justify-between rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-[var(--color-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]",
          error
            ? "border-red-300 bg-red-50/60 dark:border-red-800 dark:bg-red-950/40"
            : "border-[var(--color-border)] bg-[var(--card)]",
        )}
        aria-label={`tool call ${tc.name}${error ? " (error)" : ""}`}
      >
        <span className="flex min-w-0 items-center gap-2">
          {error ? (
            <CircleAlert className="h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400" />
          ) : (
            <Wrench className="h-3.5 w-3.5 shrink-0 text-[var(--color-muted-foreground)]" />
          )}
          <span className="truncate font-mono">{tc.name}</span>
        </span>
        <ChevronDown className="h-3.5 w-3.5 text-[var(--color-muted-foreground)] transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 space-y-2 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-2 text-xs">
        {!compact && <Separator className="my-1" />}
        <details className="group/args">
          <summary className="cursor-pointer select-none text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]">
            args
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded bg-[var(--color-muted)] p-2 font-mono text-[11px] leading-snug">
            {JSON.stringify(tc.args, null, 2)}
          </pre>
        </details>
        <details>
          <summary className="cursor-pointer select-none text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]">
            result{error ? " (error)" : ""}
          </summary>
          <pre
            className={cn(
              "mt-1 max-h-60 overflow-auto rounded p-2 font-mono text-[11px] leading-snug",
              error ? "bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-200" : "bg-[var(--color-muted)]",
            )}
          >
            {typeof parsedResult === "string" ? parsedResult : JSON.stringify(parsedResult, null, 2)}
          </pre>
        </details>
      </CollapsibleContent>
    </Collapsible>
  );
}

function CartPanel({
  cart,
  totalPaisa,
  onModify,
}: {
  cart: CartItem[];
  totalPaisa: number;
  onModify?: () => void;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div className="flex items-center gap-2">
          <ShoppingCart className="h-4 w-4" />
          <CardTitle>Cart</CardTitle>
        </div>
        <div className="flex items-center gap-1.5">
          {cart.length > 0 && onModify && (
            <Button
              size="sm"
              variant="outline"
              onClick={onModify}
              aria-label="open modify modal"
              title="Edit quantities"
            >
              Modify
            </Button>
          )}
          {cart.length > 0 && (
            <Badge>
              {cart.reduce((s, l) => s + l.quantity, 0)} item
              {cart.reduce((s, l) => s + l.quantity, 0) === 1 ? "" : "s"}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {cart.length === 0 ? (
          <div className="rounded-md border border-dashed border-[var(--color-border)] p-4 text-center text-xs text-[var(--color-muted-foreground)]">
            Nothing in the cart yet.
          </div>
        ) : (
          <>
            <ul className="divide-y divide-[var(--color-border)]">
              {cart.map((line, i) => (
                <li key={i} className="flex items-start justify-between gap-2 py-2 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{line.name}</div>
                    {line.variant_name ? (
                      <div className="text-xs text-[var(--color-muted-foreground)]">
                        {line.variant_name}
                      </div>
                    ) : null}
                    {line.addons && line.addons.length > 0 ? (
                      <div className="text-xs text-[var(--color-muted-foreground)]">
                        + {line.addons.map((a) => a.name).join(", ")}
                      </div>
                    ) : null}
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-sm">× {line.quantity}</div>
                    <div className="text-xs text-[var(--color-muted-foreground)]">
                      {formatBDT(line.line_total_paisa)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <Separator className="my-2" />
            <div className="flex items-center justify-between text-sm font-semibold">
              <span>Subtotal</span>
              <span>{formatBDT(totalPaisa)}</span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ToolCallsPanel({
  calls,
}: {
  calls: Array<ToolCall & { key: string; ts: number; error: boolean }>;
}) {
  const errors = calls.filter((c) => c.error).length;
  return (
    <Card className="flex min-h-0 flex-1 flex-col">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div className="flex items-center gap-2">
          <Wrench className="h-4 w-4" />
          <CardTitle>Tool calls</CardTitle>
        </div>
        <div className="flex items-center gap-1.5">
          {errors > 0 && (
            <Badge className="border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
              {errors} error{errors === 1 ? "" : "s"}
            </Badge>
          )}
          <Badge>
            {calls.length} total
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
        {calls.length === 0 ? (
          <div className="rounded-md border border-dashed border-[var(--color-border)] p-4 text-center text-xs text-[var(--color-muted-foreground)]">
            None yet — start a chat to see the agent's tool calls.
          </div>
        ) : (
          calls.map((tc) => <ToolCallEntry key={tc.key} tc={tc} compact />)
        )}
      </CardContent>
    </Card>
  );
}

// Unused-import suppressor: MenuIcon is reserved for a future hamburger menu.
void MenuIcon;