import type { CSSProperties, ReactNode } from "react";

// Edit-mode hooks for the homepage. In the public page `ed` and `lock` return nothing, so spreading them adds no attribute and no
// element: the public HTML is exactly what it was before the visual editor existed. In the editor's canvas they mark elements
// so a click can be mapped back to the content field behind it (data-cms), or explain why an element cannot be edited
// (data-cms-locked). The editor's canvas page does the click handling; nothing here has behaviour.

// Attributes an element gets for the editor (data-cms markers) and/or a validated look set for it (style).
export type EdAttrs = { style?: CSSProperties } & { [k: `data-${string}`]: string };
export type Ed = (path: string) => EdAttrs;
export type Lock = (reason: string) => EdAttrs;

export const noEd: Ed = () => ({});
export const editEd: Ed = (path) => ({ "data-cms": path });
export const noLock: Lock = () => ({});
export const editLock: Lock = (reason) => ({ "data-cms-locked": reason });

export const LOCK = {
  stats: "This is a live figure, counted from the database, so it cannot be typed over. Click a caption to edit it, or click the card to change how the cards look.",
  claim: "This statement describes what the product does and does not provide today. It is controlled in code so it cannot be changed by accident.",
  structure: "The layout, icons, colours and destination of this element are part of the site's design and are controlled in code.",
  notes: "This explanatory note about the figures is controlled in code.",
} as const;

// Wraps text that sits inside a component we cannot put attributes on (e.g. a button). Public mode: no wrapper at all.
export function E({ ed, path, children }: { ed: Ed; path: string; children: ReactNode }) {
  const a = ed(path);
  return Object.keys(a).length > 0 ? <span {...a}>{children}</span> : <>{children}</>;
}
