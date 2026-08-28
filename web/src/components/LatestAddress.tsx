"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MapPin } from "lucide-react";

interface Address {
  id: string;
  line1: string;
  line2: string | null;
  note_for_rider: string | null;
}

interface Props {
  phone: string;
}

/**
 * Sidebar card — shows the customer's saved default delivery address.
 *
 * Fetches GET /api/address?phone=... and renders line1 (+ line2) plus the
 * rider note when present. Renders nothing for unknown phones.
 */
export function LatestAddress({ phone }: Props) {
  const [addr, setAddr] = useState<Address | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!phone) {
      setAddr(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/address?phone=${encodeURIComponent(phone)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ address: Address | null }>;
      })
      .then((d) => {
        if (!cancelled) setAddr(d.address);
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
          <MapPin className="h-4 w-4" />
          <CardTitle>Address</CardTitle>
        </div>
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
        ) : !addr ? (
          <div className="rounded-md border border-dashed border-[var(--color-border)] p-4 text-center text-xs text-[var(--color-muted-foreground)]">
            No saved address.
          </div>
        ) : (
          <div className="space-y-1 text-sm">
            <div className="font-medium">{addr.line1}</div>
            {addr.line2 && (
              <div className="text-xs text-[var(--color-muted-foreground)]">{addr.line2}</div>
            )}
            {addr.note_for_rider && (
              <div className="text-xs text-[var(--color-muted-foreground)]">
                📝 {addr.note_for_rider}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}