"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatBDT } from "@/lib/utils";
import { Activity } from "lucide-react";

interface RecentOrderRow {
  id: string;
  state: string;
  items_summary: string;
  total_paisa: number;
  created_at: string;
  confirmed_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
}

interface Props {
  phone: string;
  /**
   * If provided, only show this order; otherwise show the most recent one
   * returned by the API. Passing a stale id is safe — we fall back to the
   * fetched list.
   */
  orderId?: string | null;
}

/**
 * Sidebar card — shows the customer's latest order state + a summary line.
 *
 * Simplification (per controller ruling): we reuse the same
 * /api/orders/recent endpoint (which already returns the most-recent order
 * first) instead of building a separate /api/orders/:id endpoint. We skip
 * notification rendering because the list view doesn't return them; that's
 * reserved for the agent's `get_order_status` tool.
 */
export function TrackLatest({ phone, orderId }: Props) {
  const [rows, setRows] = useState<RecentOrderRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!phone) {
      setRows([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/orders/recent?phone=${encodeURIComponent(phone)}&limit=5`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ orders: RecentOrderRow[] }>;
      })
      .then((d) => {
        if (!cancelled) setRows(d.orders ?? []);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [phone]);

  if (!phone) return null;

  const latest = rows[0] ?? null;
  const target = orderId ? rows.find((r) => r.id === orderId) ?? latest : latest;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4" />
          <CardTitle>Track latest</CardTitle>
        </div>
        {target && <Badge>{target.state}</Badge>}
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="rounded-md border border-dashed border-[var(--color-border)] p-4 text-center text-xs text-[var(--color-muted-foreground)]">
            Loading…
          </div>
        ) : error ? (
          <div className="rounded-md border border-dashed border-red-300 bg-red-50/60 p-3 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </div>
        ) : !target ? (
          <div className="rounded-md border border-dashed border-[var(--color-border)] p-4 text-center text-xs text-[var(--color-muted-foreground)]">
            No orders to track yet.
          </div>
        ) : (
          <div className="space-y-1 text-sm">
            <div className="text-[var(--color-muted-foreground)]">
              {target.items_summary || "—"}
            </div>
            <div className="flex items-center justify-between text-xs text-[var(--color-muted-foreground)]">
              <span>{formatBDT(target.total_paisa)}</span>
              <span>{formatTime(target)}</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function formatTime(r: RecentOrderRow): string {
  const ts = r.delivered_at ?? r.cancelled_at ?? r.confirmed_at ?? r.created_at;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
