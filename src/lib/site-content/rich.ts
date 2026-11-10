// Rich text for the website editor, as DATA, never as HTML. A value is either a plain string (the common case) or
// { runs, align? } where each run is a piece of text with a small, fixed set of marks. Nothing here can express markup,
// scripts, styles or free-form colours: colours and sizes are keys into fixed palettes, links are validated, and the renderer
// (RichText.tsx) turns runs into React elements, so there is no HTML injection path at all.
//
// This module is pure and shared: the server validates and canonicalises with it, the editor edits with it.

// Legacy palette keys (still valid in stored content and still rendered); new colours are free six-digit hex values.
export const COLORS = ["brand", "navy", "muted", "success", "warning", "danger"] as const;
// Legacy named sizes (14, 18 and 20 px); new sizes are whole pixel values.
export const SIZES = ["sm", "lg", "xl"] as const;
export const ALIGNS = ["left", "center", "right", "justify"] as const;
// A controlled list of font families: each maps to a fixed font stack in styles.ts, never to a free-form name.
export const FONTS = ["sans", "serif", "mono", "system"] as const;
export type Color = (typeof COLORS)[number];
export type Size = (typeof SIZES)[number];
export type Align = (typeof ALIGNS)[number];
export type FontKey = (typeof FONTS)[number];

export const MIN_FONT_PX = 8;
export const MAX_FONT_PX = 120;
export const LINE_HEIGHT_RANGE = [1, 3] as const;
export const SPACE_AFTER_RANGE = [0, 96] as const;
export const SPACE_BEFORE_RANGE = [0, 96] as const;
export const PAD_X_RANGE = [0, 96] as const;
export const BOX_WIDTH_RANGE = [30, 100] as const;

export const NAMED_SIZE_PX: Record<Size, number> = { sm: 14, lg: 18, xl: 20 };
export const sizePx = (s: Size | number | undefined): number | undefined => (s === undefined ? undefined : typeof s === "number" ? s : NAMED_SIZE_PX[s]);

export interface Run {
  text: string;
  b?: true;
  i?: true;
  u?: true;
  // A legacy palette key or "#rrggbb".
  color?: string;
  // Highlight ("#rrggbb").
  bg?: string;
  size?: Size | number;
  font?: FontKey;
  href?: string;
}
// Layout of a whole paragraph (not of selected words): spacing, side padding, and where a narrower box sits.
export interface BlockProps {
  lineHeight?: number;
  spaceAfter?: number;
  spaceBefore?: number;
  padX?: number;
  boxWidth?: number;
  boxAlign?: "left" | "center" | "right";
}
export const BLOCK_KEYS = ["lineHeight", "spaceAfter", "spaceBefore", "padX", "boxWidth", "boxAlign"] as const;
export function pickBlock(o: BlockProps): BlockProps {
  const out: Record<string, unknown> = {};
  for (const k of BLOCK_KEYS) if (o[k] !== undefined) out[k] = o[k];
  return out as BlockProps;
}
export type RichValue = string | ({ runs: Run[]; align?: Align } & BlockProps);

export const MAX_RUNS = 60;
export const MAX_HREF_LENGTH = 300;

// Internal destinations a link may point at (public anchors and the sign-in page), plus any https:// address and mailto:.
export const INTERNAL_LINKS: { href: string; label: string }[] = [
  { href: "/", label: "Home page" },
  { href: "/login", label: "Sign in page" },
  { href: "#uk-data", label: "UK data section" },
  { href: "#search", label: "Search section" },
  { href: "#filters", label: "Filters section" },
  { href: "#workflow", label: "Reports & CRM section" },
  { href: "#api", label: "API section" },
  { href: "#faq", label: "FAQ section" },
];

// Returns an error message, or null when the destination is acceptable.
export function validateHref(href: string): string | null {
  if (href.length === 0) return "Enter a destination.";
  if (href.length > MAX_HREF_LENGTH) return `Links are at most ${MAX_HREF_LENGTH} characters.`;
  if (INTERNAL_LINKS.some((l) => l.href === href)) return null;
  if (/^mailto:[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/i.test(href)) return null;
  if (/^https:\/\//i.test(href)) {
    let u: URL;
    try {
      u = new URL(href);
    } catch {
      return "That is not a valid web address.";
    }
    if (u.protocol !== "https:" || !u.hostname.includes(".") || u.username || u.password || /[\s<>"']/.test(href)) return "Use a plain https:// address (no spaces or credentials).";
    return null;
  }
  return "Use an https:// address, a mailto: address, or one of the site's own pages.";
}

export const isExternalHref = (href: string) => /^https:\/\//i.test(href);

// ---- reading values ----------------------------------------------------------------------------------------------------------

export const richRuns = (v: RichValue): Run[] => (typeof v === "string" ? (v === "" ? [] : [{ text: v }]) : v.runs);
export const richAlign = (v: RichValue): Align | undefined => (typeof v === "string" ? undefined : v.align);
export const richBlock = (v: RichValue): BlockProps => (typeof v === "string" ? {} : pickBlock(v));
export const runsText = (runs: readonly Run[]) => runs.reduce((n, r) => n + r.text, "");
export const richPlain = (v: RichValue): string => (typeof v === "string" ? v : runsText(v.runs));

// ---- canonical form ----------------------------------------------------------------------------------------------------------

const sameMarks = (a: Run, b: Run) => !!a.b === !!b.b && !!a.i === !!b.i && !!a.u === !!b.u && a.color === b.color && a.bg === b.bg && a.size === b.size && a.font === b.font && a.href === b.href;

// Drops empty runs and merges neighbours with identical marks. With `trim` (the server's canonical form) the outer whitespace
// of the whole value is also removed; the editor does not trim while someone is still typing. The result is the one canonical
// spelling of the content, so equal content always has equal JSON (and equal hash).
export function normalizeRuns(runs: readonly Run[], trim = true): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    if (r.text === "") continue;
    const prev = out[out.length - 1];
    if (prev && sameMarks(prev, r)) prev.text += r.text;
    else out.push({ ...r });
  }
  if (trim && out.length) {
    out[0].text = out[0].text.replace(/^\s+/, "");
    out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, "");
  }
  return out.filter((r) => r.text !== "");
}

// Runs (+ alignment) to the canonical RichValue: a plain string whenever nothing is formatted.
export function makeRich(runs: readonly Run[], align?: Align, trim = true, block: BlockProps = {}): RichValue {
  const n = normalizeRuns(runs, trim);
  const plain = n.length === 0 || (n.length === 1 && !n[0].b && !n[0].i && !n[0].u && !n[0].color && !n[0].bg && !n[0].size && !n[0].font && !n[0].href);
  const extra: BlockProps = pickBlock(block);
  if (plain && !align && Object.keys(extra).length === 0) return n[0]?.text ?? "";
  return { runs: n, ...(align ? { align } : {}), ...extra };
}

// ---- editing operations (character offsets over the concatenated text) ------------------------------------------------------

type Patch = Partial<Pick<Run, "b" | "i" | "u" | "color" | "bg" | "size" | "font" | "href">> & { clear?: ("b" | "i" | "u" | "color" | "bg" | "size" | "font" | "href")[] };

function split(runs: readonly Run[], at: number): Run[] {
  const out: Run[] = [];
  let pos = 0;
  for (const r of runs) {
    const end = pos + r.text.length;
    if (at > pos && at < end) {
      out.push({ ...r, text: r.text.slice(0, at - pos) }, { ...r, text: r.text.slice(at - pos) });
    } else out.push({ ...r });
    pos = end;
  }
  return out;
}

// Applies `edit` to every run inside [start, end). A collapsed range changes nothing.
export function mapRange(runs: readonly Run[], start: number, end: number, edit: (r: Run) => Run): Run[] {
  if (end <= start) return runs.map((r) => ({ ...r }));
  const parts = split(split(runs, start), end);
  let pos = 0;
  return normalizeRuns(
    parts.map((r) => {
      const s = pos;
      pos += r.text.length;
      return s >= start && pos <= end ? edit(r) : r;
    }),
    false
  );
}

export function covered(runs: readonly Run[], start: number, end: number): Run[] {
  const parts = split(split(runs, start), end);
  let pos = 0;
  const out: Run[] = [];
  for (const r of parts) {
    const s = pos;
    pos += r.text.length;
    if (s >= start && pos <= end) out.push(r);
  }
  return out;
}

export function toggleMark(runs: readonly Run[], start: number, end: number, mark: "b" | "i" | "u"): Run[] {
  const on = covered(runs, start, end).every((r) => r[mark]);
  return mapRange(runs, start, end, (r) => {
    const next = { ...r };
    if (on) delete next[mark];
    else next[mark] = true;
    return next;
  });
}

export function setMark(runs: readonly Run[], start: number, end: number, patch: Patch): Run[] {
  return mapRange(runs, start, end, (r) => {
    const { clear, ...set } = patch;
    const next: Run = { ...r, ...set };
    for (const k of clear ?? []) delete next[k];
    return next;
  });
}

export function clearFormatting(runs: readonly Run[], start: number, end: number): Run[] {
  return mapRange(runs, start, end, (r) => ({ text: r.text }));
}

// What the toolbar should show for a selection: a mark is "on" only when every selected character has it.
export function selectionState(runs: readonly Run[], start: number, end: number) {
  const cov = covered(runs, start, end);
  const all = (f: (r: Run) => boolean) => cov.length > 0 && cov.every(f);
  const first = cov[0];
  return {
    b: all((r) => !!r.b),
    i: all((r) => !!r.i),
    u: all((r) => !!r.u),
    color: first && cov.every((r) => r.color === first.color) ? first.color : undefined,
    bg: first && cov.every((r) => r.bg === first.bg) ? first.bg : undefined,
    size: first && cov.every((r) => r.size === first.size) ? first.size : undefined,
    font: first && cov.every((r) => r.font === first.font) ? first.font : undefined,
    href: first && cov.every((r) => r.href === first.href) ? first.href : undefined,
  };
}
