"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Minus, Plus } from "lucide-react";
import { formatBDT } from "@/lib/utils";

/**
 * Minimal order item shape used inside the modify modal — just enough to
 * render a quantity stepper and pass back a `menu_item_id` + new quantity.
 * Variant / addon fields are intentionally ignored: per the brief, this is
 * a quantity-only edit UI demo.
 */
export interface ModifyItem {
  menu_item_id: string;
  name: string;
  quantity: number;
  unit_price_paisa: number;
}

export interface ModifySubmitItem {
  menu_item_id: string;
  quantity: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  items: ModifyItem[];
  onApply: (items: ModifySubmitItem[]) => void;
}

/**
 * Lightweight quantity-stepper modal for the operator-driven modify flow.
 *
 * The parent opens this when it wants to edit a pending order; `onApply`
 * receives the new items list (only `menu_item_id` + `quantity`) which it
 * then formats into a Bangla "modify" message and sends into the chat.
 *
 * Items whose quantity drops to 0 are kept in the submission (the parent
 * can decide whether zero means "remove" — this UI is intentionally
 * permissive).
 */
export function ModifyModal({ open, onClose, items, onApply }: Props) {
  const [draft, setDraft] = useState<ModifyItem[]>([]);

  // Reset draft whenever the modal is (re)opened with a new items list.
  useEffect(() => {
    if (open) setDraft(items.map((i) => ({ ...i })));
  }, [open, items]);

  function setQty(menuItemId: string, qty: number) {
    const clamped = Math.max(0, Math.min(99, Math.floor(qty)));
    setDraft((d) => d.map((i) => (i.menu_item_id === menuItemId ? { ...i, quantity: clamped } : i)));
  }

  function adjust(menuItemId: string, delta: number) {
    setDraft((d) =>
      d.map((i) =>
        i.menu_item_id === menuItemId ? { ...i, quantity: Math.max(0, Math.min(99, i.quantity + delta)) } : i,
      ),
    );
  }

  function apply() {
    onApply(
      draft.map((i) => ({ menu_item_id: i.menu_item_id, quantity: i.quantity })),
    );
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogHeader>
        <DialogTitle>Modify order</DialogTitle>
        <DialogClose onClick={onClose} />
      </DialogHeader>
      <DialogContent>
        {items.length === 0 ? (
          <div className="rounded-md border border-dashed border-[var(--color-border)] p-4 text-center text-xs text-[var(--color-muted-foreground)]">
            No items to modify.
          </div>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {items.map((orig) => {
              const current = draft.find((d) => d.menu_item_id === orig.menu_item_id);
              const qty = current?.quantity ?? orig.quantity;
              return (
                <li key={orig.menu_item_id} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{orig.name}</div>
                    <div className="text-xs text-[var(--color-muted-foreground)]">
                      {formatBDT(orig.unit_price_paisa)} each
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      className="h-7 w-7"
                      onClick={() => adjust(orig.menu_item_id, -1)}
                      disabled={qty <= 0}
                      aria-label={`decrease ${orig.name}`}
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </Button>
                    <input
                      type="number"
                      min={0}
                      max={99}
                      value={qty}
                      onChange={(e) => setQty(orig.menu_item_id, Number(e.target.value || 0))}
                      className="h-7 w-12 rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-2 text-center text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
                      aria-label={`quantity for ${orig.name}`}
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      className="h-7 w-7"
                      onClick={() => adjust(orig.menu_item_id, 1)}
                      disabled={qty >= 99}
                      aria-label={`increase ${orig.name}`}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </DialogContent>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={apply} disabled={items.length === 0}>
          Apply
        </Button>
      </DialogFooter>
    </Dialog>
  );
}