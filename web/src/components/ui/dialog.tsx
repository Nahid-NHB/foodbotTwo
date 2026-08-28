"use client";

import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

/**
 * Lightweight modal dialog — no Radix dependency.
 *
 * Renders nothing when closed. When open, mounts a fixed overlay + panel.
 * Clicking the backdrop or pressing Escape calls onOpenChange(false).
 */
export function Dialog({ open, onOpenChange, children }: DialogProps) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/50"
        aria-label="close dialog"
        onClick={() => onOpenChange(false)}
      />
      <div className="relative z-10 w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] shadow-xl">
        {children}
      </div>
    </div>
  );
}

interface DialogHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export function DialogHeader({ className, children, ...props }: DialogHeaderProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function DialogTitle({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("text-base font-semibold", className)}
      {...props}
    />
  );
}

interface DialogContentProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export function DialogContent({ className, children, ...props }: DialogContentProps) {
  return (
    <div className={cn("p-4", className)} {...props}>
      {children}
    </div>
  );
}

interface DialogFooterProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export function DialogFooter({ className, children, ...props }: DialogFooterProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-end gap-2 border-t border-[var(--color-border)] px-4 py-3",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

interface DialogCloseProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children?: React.ReactNode;
}

export function DialogClose({ children, ...props }: DialogCloseProps) {
  return (
    <button
      type="button"
      className="rounded-md p-1 text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
      aria-label="close"
      {...props}
    >
      {children ?? <X className="h-4 w-4" />}
    </button>
  );
}
