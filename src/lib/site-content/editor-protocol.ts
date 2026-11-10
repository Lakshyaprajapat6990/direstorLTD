// Messages between the editor (parent page) and the canvas (the homepage rendered in an iframe). Same origin only: both sides
// check event.origin and event.source before reading a message.

export type ToCanvas = { type: "cms:content"; content: unknown } | { type: "cms:select"; path: string | null; scroll?: boolean };
export type FromCanvas = { type: "cms:ready" } | { type: "cms:select"; path: string | null } | { type: "cms:locked"; reason: string };

const isObj = (v: unknown): v is { type: string } => typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";

export function asToCanvas(v: unknown): ToCanvas | null {
  if (!isObj(v)) return null;
  if (v.type === "cms:content") return { type: "cms:content", content: (v as unknown as { content: unknown }).content };
  if (v.type === "cms:select") {
    const m = v as unknown as { path: unknown; scroll?: unknown };
    return { type: "cms:select", path: typeof m.path === "string" ? m.path : null, scroll: m.scroll === true };
  }
  return null;
}

export function asFromCanvas(v: unknown): FromCanvas | null {
  if (!isObj(v)) return null;
  if (v.type === "cms:ready") return { type: "cms:ready" };
  if (v.type === "cms:select") return { type: "cms:select", path: typeof (v as unknown as { path: unknown }).path === "string" ? (v as unknown as { path: string }).path : null };
  if (v.type === "cms:locked" && typeof (v as unknown as { reason: unknown }).reason === "string") return { type: "cms:locked", reason: (v as unknown as { reason: string }).reason.slice(0, 400) };
  return null;
}
