"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

// Accessible modal: role="dialog" aria-modal, focus moves in and returns, Tab stays inside, Escape and the backdrop close it.
export function Dialog({ open, title, onClose, children, size = "md" }: { open: boolean; title: string; onClose: () => void; children: ReactNode; size?: "md" | "lg" }) {
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusables = () => [...(box.current?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? [])].filter((e) => !e.hasAttribute("disabled"));
    (focusables()[1] ?? focusables()[0] ?? box.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === "Tab") {
        const f = focusables();
        if (f.length === 0) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className={cn("max-h-[90vh] w-full overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl outline-none", size === "lg" ? "max-w-3xl" : "max-w-lg")}>
        <div className="flex items-start justify-between gap-4">
          <h2 id={titleId} className="text-lg font-semibold text-slate-900">
            {title}
          </h2>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded-md p-1 text-slate-500 hover:bg-slate-100 focus-ring">
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}

export function ConfirmDialog({ open, title, confirmLabel, danger, busy, onConfirm, onCancel, children }: { open: boolean; title: string; confirmLabel: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onCancel: () => void; children?: ReactNode }) {
  return (
    <Dialog open={open} title={title} onClose={onCancel}>
      <div className="space-y-4 text-sm text-slate-600">{children}</div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} disabled={busy} data-testid="confirm-action">
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
