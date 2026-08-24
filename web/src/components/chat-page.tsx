"use client";

import { useEffect, useRef, useState } from "react";
import { Send, Bot, User, ShoppingCart, Wrench, Trash2 } from "lucide-react";

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
import { formatBDT } from "@/lib/utils";

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
}

interface ChatResponse {
  reply: string;
  toolCalls: ToolCall[];
  cart: CartItem[];
  tokensUsed: number;
}

// ---------- helpers ----------

const STORAGE_KEY = "foodbot-test-chat-v1";
const DEFAULT_PHONE = "+8801700009999";

function loadFromStorage(): { phone: string; messages: Message[] } {
  if (typeof window === "undefined") return { phone: DEFAULT_PHONE, messages: [] };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { phone: DEFAULT_PHONE, messages: [] };
    const parsed = JSON.parse(raw) as { phone?: string; messages?: Message[] };
    return {
      phone: parsed.phone ?? DEFAULT_PHONE,
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    };
  } catch {
    return { phone: DEFAULT_PHONE, messages: [] };
  }
}

// ---------- component ----------

export function ChatPage() {
  const [phone, setPhone] = useState(DEFAULT_PHONE);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [sending, setSending] = useState(false);
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
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ phone, messages }),
    );
  }, [phone, messages]);

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    const userMsg: Message = {
      id: `user-${Date.now()}`,
      role: "user",
      text: trimmed,
    };
    const pendingMsg: Message = {
      id: `agent-${Date.now()}`,
      role: "agent",
      text: "…",
      pending: true,
    };
    setMessages((m) => [...m, userMsg, pendingMsg]);
    setDraft("");
    setSending(true);

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
              }
            : msg,
        ),
      );
    } catch (err) {
      setMessages((m) =>
        m.map((msg) =>
          msg.id === pendingMsg.id
            ? {
                ...msg,
                pending: false,
                text: `Error: ${err instanceof Error ? err.message : String(err)}`,
              }
            : msg,
        ),
      );
    } finally {
      setSending(false);
    }
  }

  function clearChat() {
    setMessages([]);
  }

  const cart = [...messages].reverse().find((m) => m.role === "agent" && m.cart)?.cart ?? [];

  return (
    <div className="grid h-dvh grid-cols-1 lg:grid-cols-[1fr_360px]">
      {/* Main chat panel */}
      <div className="flex flex-col">
        <header className="flex items-center justify-between border-b border-[var(--color-border)] px-6 py-3">
          <div className="flex items-center gap-3">
            <Avatar>
              <AvatarFallback>FB</AvatarFallback>
            </Avatar>
            <div>
              <div className="text-sm font-semibold">FoodBot Test Chat</div>
              <div className="text-xs text-[var(--color-muted-foreground)]">
                Drives the agent via POST /api/chat
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="h-8 w-44 text-xs"
              placeholder="+8801700009999"
              aria-label="phone"
            />
            <Button
              variant="ghost"
              size="icon"
              onClick={clearChat}
              aria-label="clear chat"
              disabled={messages.length === 0}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </header>

        <ScrollArea className="flex-1">
          <div ref={scrollRef} className="space-y-4 p-6">
            {messages.length === 0 && (
              <div className="rounded-lg border border-dashed border-[var(--color-border)] p-8 text-center text-sm text-[var(--color-muted-foreground)]">
                Send a message to start. Try{" "}
                <button
                  type="button"
                  className="underline"
                  onClick={() => send("আসসালামু আলাইকুম")}
                >
                  আসসালামু আলাইকুম
                </button>{" "}
                or{" "}
                <button
                  type="button"
                  className="underline"
                  onClick={() => send("menu dekhao")}
                >
                  menu dekhao
                </button>
                .
              </div>
            )}
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}
          </div>
        </ScrollArea>

        <form
          className="flex items-center gap-2 border-t border-[var(--color-border)] p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void send(draft);
          }}
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Type a message in Bangla or English…"
            disabled={sending}
            autoFocus
          />
          <Button type="submit" size="icon" disabled={sending || !draft.trim()}>
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </div>

      {/* Sidebar: cart + last tool calls */}
      <aside className="hidden flex-col border-l border-[var(--color-border)] bg-[var(--color-muted)]/30 p-4 lg:flex">
        <Card className="mb-4">
          <CardHeader className="flex flex-row items-center gap-2 space-y-0">
            <ShoppingCart className="h-4 w-4" />
            <CardTitle>Cart</CardTitle>
          </CardHeader>
          <CardContent>
            {cart.length === 0 ? (
              <div className="text-xs text-[var(--color-muted-foreground)]">Empty.</div>
            ) : (
              <ul className="space-y-2 text-sm">
                {cart.map((line, i) => (
                  <li key={i} className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{line.name}</div>
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
                      <div>× {line.quantity}</div>
                      <div className="text-xs text-[var(--color-muted-foreground)]">
                        {formatBDT(line.line_total_paisa)}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="flex-1 overflow-hidden">
          <CardHeader className="flex flex-row items-center gap-2 space-y-0">
            <Wrench className="h-4 w-4" />
            <CardTitle>Recent tool calls</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 overflow-y-auto">
            {[...messages]
              .reverse()
              .flatMap((m) =>
                (m.toolCalls ?? []).map((tc, i) => ({ ...tc, key: `${m.id}-${i}` })),
              )
              .slice(0, 10)
              .map((tc) => (
                <ToolCallEntry key={tc.key} tc={tc} />
              ))}
            {messages.every((m) => !m.toolCalls || m.toolCalls.length === 0) && (
              <div className="text-xs text-[var(--color-muted-foreground)]">
                None yet.
              </div>
            )}
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}

// ---------- subcomponents ----------

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex gap-3 ${isUser ? "justify-end" : "justify-start"}`}>
      {!isUser && (
        <Avatar>
          <AvatarFallback>
            <Bot className="h-4 w-4" />
          </AvatarFallback>
        </Avatar>
      )}
      <div className={`max-w-[75%] space-y-2 ${isUser ? "items-end" : "items-start"}`}>
        <div
          className={`rounded-lg px-4 py-2 text-sm ${
            isUser
              ? "bg-[var(--color-primary)] text-[var(--color-primary-foreground)]"
              : "bg-[var(--color-muted)]"
          }`}
        >
          {message.pending ? (
            <span className="text-[var(--color-muted-foreground)]">thinking…</span>
          ) : (
            message.text
          )}
        </div>
        {!isUser && !message.pending && (message.toolCalls?.length ?? 0) > 0 && (
          <div className="space-y-1">
            {message.toolCalls!.map((tc, i) => (
              <ToolCallEntry key={i} tc={tc} compact />
            ))}
          </div>
        )}
        {!isUser && !message.pending && message.tokensUsed !== undefined && (
          <Badge className="text-[10px]">
            {message.tokensUsed} tokens
          </Badge>
        )}
      </div>
      {isUser && (
        <Avatar>
          <AvatarFallback>
            <User className="h-4 w-4" />
          </AvatarFallback>
        </Avatar>
      )}
    </div>
  );
}

function ToolCallEntry({ tc, compact = false }: { tc: ToolCall; compact?: boolean }) {
  let parsedResult: unknown = tc.result;
  try {
    parsedResult = JSON.parse(tc.result);
  } catch {
    // keep as string
  }

  return (
    <Collapsible>
      <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md border border-[var(--color-border)] bg-[var(--card)] px-3 py-1.5 text-left text-xs hover:bg-[var(--color-accent)]">
        <span className="font-mono">{tc.name}</span>
        <span className="text-[var(--color-muted-foreground)]">›</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 space-y-1 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-2 text-xs">
        {!compact && <Separator className="my-1" />}
        <div>
          <div className="mb-1 font-semibold text-[var(--color-muted-foreground)]">args</div>
          <pre className="overflow-x-auto rounded bg-[var(--color-muted)] p-2 font-mono text-[11px]">
            {JSON.stringify(tc.args, null, 2)}
          </pre>
        </div>
        <div>
          <div className="mb-1 font-semibold text-[var(--color-muted-foreground)]">result</div>
          <pre className="overflow-x-auto rounded bg-[var(--color-muted)] p-2 font-mono text-[11px]">
            {typeof parsedResult === "string"
              ? parsedResult
              : JSON.stringify(parsedResult, null, 2)}
          </pre>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}