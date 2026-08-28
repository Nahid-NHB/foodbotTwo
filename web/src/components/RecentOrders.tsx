"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatBDT } from "@/lib/utils";
import { ShoppingBag } from "lucide-react";

interface RecentOrderRow {
  id: string;
  state: string;
  items_summary: string;
  total_paisa: number;
  created_at: string;
}

interface Props {
  phone: string;
  onReorder: (orderId: string) => void;
}

/**
 * Sidebar card — shows the customer's most-recent orders with a Reorder button.
 *
 * Fetches GET /api/orders/recent?phone=... and renders up to 5 rows. The
 * Reorder button is wired by the parent (chat-page) to fire a Bangla reorder
 * prompt into the chat input via the existing `send` callback.
 */
export function RecentOrders({ phone, onReorder }: Props) {
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
    fetch(`/api/orders/recent?phone=${encodeURIComponent(phone)}`)
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

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div className="flex items-center gap-2">
          <ShoppingBag className="h-4 w-4" />
          <CardTitle>Recent orders</CardTitle>
        </div>
        {rows.length > 0 && <Badge>{rows.length}</Badge>}
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
        ) : rows.length === 0 ? (
          <div className="rounded-md border border-dashed border-[var(--color-border)] p-4 text-center text-xs text-[var(--color-muted-foreground)]">
            No prior orders.
          </div>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {rows.map((r) => (
              <li key={r.id} className="flex items-start justify-between gap-2 py-2 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{r.items_summary || "—"}</div>
                  <div className="text-xs text-[var(--color-muted-foreground)]">
                    {r.state} · {formatBDT(r.total_paisa)}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onReorder(r.id)}
                  aria-label={`reorder ${r.id}`}
                  title="Send a reorder message"
                >
                  Reorder
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
