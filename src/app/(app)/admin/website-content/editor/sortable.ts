"use client";

import { useState, type DragEvent } from "react";

// Drag-and-drop reordering for a short list (the blocks of a text section). Plain HTML5 drag events; every row also has Up and Down
// buttons elsewhere, so reordering never depends on a mouse. `onMove(from, to)` receives the index the item should END at.
export function useSortable(count: number, onMove: (from: number, to: number) => void) {
  const [drag, setDrag] = useState<number | null>(null);
  const [gap, setGap] = useState<number | null>(null);
  const valid = (g: number) => drag !== null && g >= 0 && g <= count && g !== drag && g !== drag + 1;
  const end = () => {
    setDrag(null);
    setGap(null);
  };
  return {
    dragging: drag,
    // True when the drop indicator belongs on the top edge of row `i`.
    indicatorBefore: (i: number) => drag !== null && gap === i && valid(i),
    indicatorAfterLast: drag !== null && gap === count && valid(count),
    rowProps: (i: number) => ({
      draggable: true,
      onDragStart: (e: DragEvent) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(i));
        setDrag(i);
      },
      onDragOver: (e: DragEvent) => {
        if (drag === null) return;
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const g = e.clientY < r.top + r.height / 2 ? i : i + 1;
        if (valid(g)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setGap(g);
        } else {
          setGap(null);
        }
      },
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        if (drag !== null && gap !== null && valid(gap)) onMove(drag, gap > drag ? gap - 1 : gap);
        end();
      },
      onDragEnd: end,
    }),
  };
}
