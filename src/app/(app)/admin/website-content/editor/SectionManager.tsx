"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, GripVertical, Lock, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { finalIndexForGap, sectionLabel } from "@/lib/site-content/editor-model";
import type { EditableContent } from "@/lib/site-content/schema";
import { isCustomKey, lockReason, sectionInfo, type OrderKey } from "@/lib/site-content/styles";

// The list of every section of the homepage, in the order the page really uses. Dragging a row (or using its Up/Down buttons)
// changes `content.order`, which the page renders from: the canvas updates at once. The hero and the closing call to action are
// fixed at the two ends and say why.

export interface SectionManagerProps {
  content: EditableContent;
  order: OrderKey[];
  isDefaultOrder: boolean;
  selectedKey: OrderKey | null;
  onSelect: (key: OrderKey) => void;
  onMove: (key: OrderKey, finalIndex: number) => void;
  onReset: () => void;
  onRemove: (customIndex: number) => void;
}

export function SectionManager(p: SectionManagerProps) {
  const [drag, setDrag] = useState<OrderKey | null>(null);
  const [gap, setGap] = useState<number | null>(null);
  const n = p.order.length;
  const from = drag ? p.order.indexOf(drag) : -1;
  // A gap is a drop position between rows (0..n); the hero's and the call to action's ends are not valid drops.
  const valid = (g: number) => g >= 1 && g <= n - 1 && g !== from && g !== from + 1;

  const end = () => {
    setDrag(null);
    setGap(null);
  };

  return (
    <div data-testid="section-manager">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Page sections ({n})</p>
        <Button size="sm" variant="ghost" onClick={p.onReset} disabled={p.isDefaultOrder} data-testid="reset-order" title={p.isDefaultOrder ? "The sections are already in their original order" : "Put every section back in its original place"}>
          <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Reset order
        </Button>
      </div>
      <p className="mt-1 text-xs text-slate-500">Drag a section by its handle, or use the arrows, to change the order of the page. The page on the left changes as you move it.</p>
      <ol className="mt-2" aria-label="Sections of the page, in page order">
        {p.order.map((key, i) => {
          const custom = isCustomKey(key);
          const reason = lockReason(key);
          const info = custom ? null : sectionInfo(key);
          const note = reason ?? (info && "note" in info ? info.note : null);
          const customIndex = custom ? p.content.custom.findIndex((s) => `custom:${s.id}` === key) : -1;
          const canUp = !reason && i > 1;
          const canDown = !reason && i < n - 2;
          return (
            <li key={key} className="relative">
              {drag && gap === i && valid(i) && <div aria-hidden data-testid="drop-indicator" className="absolute -top-px left-0 right-0 z-10 h-0.5 rounded bg-indigo-500" />}
              <div
                draggable={!reason}
                data-section-key={key}
                data-locked={reason ? "true" : undefined}
                data-dragging={drag === key ? "true" : undefined}
                onDragStart={(e) => {
                  if (reason) return e.preventDefault();
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", key);
                  setDrag(key);
                }}
                onDragOver={(e) => {
                  if (!drag) return;
                  const r = e.currentTarget.getBoundingClientRect();
                  const g = e.clientY < r.top + r.height / 2 ? i : i + 1;
                  if (valid(g)) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    setGap(g);
                  } else {
                    e.dataTransfer.dropEffect = "none";
                    setGap(null);
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (drag && gap !== null && valid(gap)) p.onMove(drag, finalIndexForGap(from, gap));
                  end();
                }}
                onDragEnd={end}
                onKeyDown={(e) => {
                  if (!e.altKey || reason || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                  e.preventDefault();
                  const to = e.key === "ArrowUp" ? i - 1 : i + 1;
                  p.onMove(key, to);
                }}
                className={cn("flex items-center gap-1 rounded-lg border bg-white py-1 pl-1 pr-1.5 my-0.5", p.selectedKey === key ? "border-indigo-400 bg-indigo-50/40" : "border-slate-200", drag === key && "opacity-40", !reason && "cursor-grab active:cursor-grabbing")}
              >
                <span className={cn("flex h-7 w-6 shrink-0 items-center justify-center", reason ? "text-slate-300" : "text-slate-400")} aria-hidden title={reason ?? "Drag to move"} data-testid="drag-handle">
                  {reason ? <Lock className="h-3.5 w-3.5" /> : <GripVertical className="h-4 w-4" />}
                </span>
                <button type="button" onClick={() => p.onSelect(key)} data-testid="section-row" className="min-w-0 flex-1 rounded-md px-1 py-0.5 text-left focus-ring">
                  <span className="block truncate text-sm font-medium text-slate-800">
                    <span className="mr-1.5 tabular-nums text-slate-400">{i + 1}.</span>
                    {sectionLabel(p.content, key)}
                  </span>
                  <span className="block truncate text-[11px] text-slate-400">{custom ? "Added section" : "Built-in section"}</span>
                  {note && <span className="block text-[11px] leading-snug text-slate-500">{note}</span>}
                </button>
                <button type="button" aria-label={`Move ${sectionLabel(p.content, key)} up`} title={reason ?? (canUp ? "Move up" : "Nothing can go above the hero")} disabled={!canUp} onClick={() => p.onMove(key, i - 1)} data-testid="move-up" className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30 focus-ring">
                  <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                </button>
                <button type="button" aria-label={`Move ${sectionLabel(p.content, key)} down`} title={reason ?? (canDown ? "Move down" : "Nothing can go below the final call to action")} disabled={!canDown} onClick={() => p.onMove(key, i + 1)} data-testid="move-down" className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30 focus-ring">
                  <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                </button>
                {custom && customIndex >= 0 && (
                  <button type="button" aria-label={`Remove ${sectionLabel(p.content, key)}`} title="Remove this section" onClick={() => p.onRemove(customIndex)} data-testid="remove-section" className="rounded p-1 text-slate-500 hover:bg-red-50 hover:text-red-600 focus-ring">
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
