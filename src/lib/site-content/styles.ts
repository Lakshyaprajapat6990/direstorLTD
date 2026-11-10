import type { CSSProperties } from "react";
import { FONTS, type FontKey } from "./rich";
import type { SlotId } from "./sections";

// Appearance settings for the homepage, as validated DATA. Nothing here is a stylesheet: every value is a number inside a fixed
// range, a keyword from a fixed list, or a six-digit hex colour, and the functions below are the only place they become CSS.
// That is why editors can restyle buttons, headings, sections and images without any way to inject CSS.
//
// Pure module: used by the server (validation, rendering) and the browser (editor).

export { FONTS };
export type { FontKey };

export const FONT_STACK: Record<FontKey, string> = {
  sans: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
  serif: "Georgia, 'Times New Roman', Times, serif",
  mono: "var(--font-geist-mono), ui-monospace, SFMono-Regular, Menlo, monospace",
  system: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
};
export const FONT_LABEL: Record<FontKey, string> = { sans: "Site font", serif: "Serif", mono: "Monospace", system: "System" };

export const WEIGHTS = ["normal", "medium", "semibold", "bold", "extrabold"] as const;
export type Weight = (typeof WEIGHTS)[number];
export const WEIGHT_VALUE: Record<Weight, number> = { normal: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800 };
export const WEIGHT_LABEL: Record<Weight, string> = { normal: "Regular", medium: "Medium", semibold: "Semi-bold", bold: "Bold", extrabold: "Extra bold" };

export const BOX_ALIGNS = ["left", "center", "right"] as const;
export type BoxAlign = (typeof BOX_ALIGNS)[number];

// Ranges (inclusive). The editor's number inputs and the validation use the same table.
export const LIMITS = {
  headingSize: [12, 140],
  buttonSize: [10, 32],
  padX: [8, 80],
  padY: [4, 40],
  radius: [0, 48],
  borderWidth: [0, 8],
  sectionPad: [0, 240],
  imageSide: [24, 1600],
} as const;

// ---- element settings ----------------------------------------------------------------------------------------------------------

export interface HeadingStyle {
  font?: FontKey;
  size?: number;
  weight?: Weight;
  italic?: true;
  color?: string;
  // The two parts of a two-part heading can also be styled on their own (the highlighted part keeps its brand colour by default).
  accentColor?: string;
  leadFont?: FontKey;
  leadWeight?: Weight;
  leadItalic?: true;
  accentFont?: FontKey;
  accentWeight?: Weight;
  accentItalic?: true;
  align?: BoxAlign;
}

// Look of the six figure cards of the UK register section (shared by all six). The figures themselves stay live data.
export interface StatCardStyle {
  bg?: string;
  borderColor?: string;
  borderWidth?: number;
  radius?: number;
  padX?: number;
  padY?: number;
  align?: BoxAlign;
  valueColor?: string;
  valueSize?: number;
  valueWeight?: Weight;
  valueFont?: FontKey;
  valueItalic?: true;
  labelColor?: string;
  labelSize?: number;
  labelWeight?: Weight;
  labelItalic?: true;
}

// The cards of the UK register section that can be selected one by one: the six figure cards and the large register card.
export const CARD_KEYS = ["total", "active", "dissolved", "directors", "filters", "sync", "register"] as const;
export type CardKey = (typeof CARD_KEYS)[number];
export const CARD_LABEL: Record<CardKey, string> = { total: "Companies loaded", active: "Active", dissolved: "Dissolved", directors: "With confirmed directors", filters: "Filter fields", sync: "Last data sync", register: "Companies House register card" };
export const isCardKey = (k: string): k is CardKey => (CARD_KEYS as readonly string[]).includes(k);

// A picture that fills a decorative picture slot of the design (a circle, a card header). Its shape and size stay the design's.
export interface ImageRef {
  mediaId: string;
  alt: string;
  fit?: "contain" | "cover";
}
export type CardImageTarget = { type: "circle"; index: 0 | 1 | 2 } | { type: "useCase"; index: number };

// Editable captions of those cards and of the register card next to them (the numbers are never editable).
export const STAT_LABEL_DEFAULTS = {
  total: "UK companies loaded",
  active: "Active",
  dissolved: "Dissolved",
  directors: "With confirmed directors",
  filters: "Filter fields",
  sync: "Last data sync",
  cardTitle: "Companies House register",
  cardSub: "United Kingdom · registration ID: company number",
  cardCaption: "companies loaded in DIRECTOR.LTD",
} as const;
export type StatLabelKey = keyof typeof STAT_LABEL_DEFAULTS;
export const STAT_LABEL_KEYS = Object.keys(STAT_LABEL_DEFAULTS) as [StatLabelKey, ...StatLabelKey[]];
export const isStatLabelKey = (k: string): k is StatLabelKey => k in STAT_LABEL_DEFAULTS;

export interface ButtonSettings {
  // Destination override (validated; ignored for buttons whose destination is locked in code).
  href?: string;
  newTab?: true;
  font?: FontKey;
  size?: number;
  weight?: Weight;
  color?: string;
  bg?: string;
  borderColor?: string;
  borderWidth?: number;
  radius?: number;
  padX?: number;
  padY?: number;
  align?: BoxAlign;
}

export interface SectionStyle {
  bg?: string;
  padTop?: number;
  padBottom?: number;
}

export interface ImageDisplay {
  displayWidth?: number;
  displayHeight?: number;
  fit?: "contain" | "cover";
  align?: BoxAlign;
  radius?: number;
  borderWidth?: number;
  borderColor?: string;
  // Float the image so the text that follows wraps around it (on screens wider than a phone).
  wrap?: "none" | "left" | "right";
}

// ---- which elements can be styled -----------------------------------------------------------------------------------------------

// Key = the content path of the heading text. `parts` headings are made of a first and a highlighted second part.
export const HEADINGS = {
  "hero.heading": { label: "Main heading", level: "h1", parts: true, color: "#0b2a6f", on: "#ffffff" },
  "ukRegister.heading": { label: "UK register heading", level: "h2", parts: true, color: "#0b2a6f", on: "#ffffff" },
  "workflow.heading": { label: "Reports & CRM heading", level: "h2", parts: true, color: "#0b2a6f", on: "#f8fafc" },
  "useCases.heading": { label: "Use cases heading", level: "h2", parts: true, color: "#0b2a6f", on: "#ffffff" },
  "officialSource.heading": { label: "Official source heading", level: "h2", parts: false, color: "#0b2a6f", on: "#ffffff" },
  "search.heading": { label: "Search heading", level: "h2", parts: false, color: "#0b2a6f", on: "#f4f7ff" },
  "filters.heading": { label: "Filters heading", level: "h2", parts: false, color: "#0b2a6f", on: "#ffffff" },
  "platform.heading": { label: "Platform heading", level: "h2", parts: false, color: "#0b2a6f", on: "#ffffff" },
  "apart.heading": { label: "What sets us apart heading", level: "h2", parts: false, color: "#0b2a6f", on: "#f8fafc" },
  "apart.talk.title": { label: "“Talk to us” title", level: "p", parts: false, color: "#0b2a6f", on: "#f8fafc" },
  "faq.heading": { label: "FAQ heading", level: "h2", parts: false, color: "#0b2a6f", on: "#ffffff" },
  "finalCta.heading": { label: "Final call to action heading", level: "h2", parts: false, color: "#ffffff", on: "#0b2a6f" },
} as const;
export type HeadingKey = keyof typeof HEADINGS;
export const HEADING_KEYS = Object.keys(HEADINGS) as [HeadingKey, ...HeadingKey[]];
export const isHeadingKey = (k: string): k is HeadingKey => k in HEADINGS;

const SIGN_IN_LOCK = "Sign-in buttons always open the sign-in page. A changeable destination could send visitors to a look-alike login page, so it is fixed in code.";

// Buttons the editor can restyle. `locked` buttons keep their destination (label and appearance remain editable).
export const BUTTONS = {
  "hero.primary": { label: "Hero: main button", labelPath: "hero.primaryCtaLabel", defaultHref: "/login", look: { bg: "#1a56e8", color: "#ffffff" }, locked: SIGN_IN_LOCK, row: "hero.buttons" },
  "hero.secondary": { label: "Hero: second button", labelPath: "hero.secondaryCtaLabel", defaultHref: "#uk-data", look: { bg: "#ffffff", color: "#1a56e8", border: "#1a56e8" }, row: "hero.buttons" },
  "source.cta": { label: "Official source: button", labelPath: "officialSource.ctaLabel", defaultHref: "/login", look: { bg: "#1a56e8", color: "#ffffff" }, locked: SIGN_IN_LOCK },
  "apart.cta": { label: "“Talk to us”: button", labelPath: "apart.talk.ctaLabel", defaultHref: "/login", look: { bg: "#1a56e8", color: "#ffffff" }, locked: SIGN_IN_LOCK },
  "workflow.try": { label: "Reports & CRM: button", labelPath: "workflow.tryLabel", defaultHref: "/login", look: { bg: "#1a56e8", color: "#ffffff" }, locked: SIGN_IN_LOCK },
  "final.primary": { label: "Final call to action: main button", labelPath: "finalCta.primaryLabel", defaultHref: "/login", look: { bg: "#ffffff", color: "#0b2a6f" }, locked: SIGN_IN_LOCK, row: "final.buttons" },
  "final.secondary": { label: "Final call to action: second button", labelPath: "finalCta.secondaryLabel", defaultHref: "#uk-data", look: { bg: "#0b2a6f", color: "#ffffff", border: "#ffffff" }, row: "final.buttons" },
} as const satisfies Record<string, { label: string; labelPath: string; defaultHref: string; look: { bg: string; color: string; border?: string }; locked?: string; row?: string }>;
export type ButtonKey = keyof typeof BUTTONS;
export const BUTTON_KEYS = Object.keys(BUTTONS) as [ButtonKey, ...ButtonKey[]];
export const isButtonKey = (k: string): k is ButtonKey => k in BUTTONS;
export const buttonForLabelPath = (path: string): ButtonKey | null => BUTTON_KEYS.find((k) => BUTTONS[k].labelPath === path) ?? null;
// Buttons side by side share one row, which is what "alignment" moves; the others sit alone and align themselves.
export const ROWS = { "hero.buttons": "Hero buttons", "final.buttons": "Final call to action buttons" } as const;
export type RowKey = keyof typeof ROWS;
export const ROW_KEYS = Object.keys(ROWS) as [RowKey, ...RowKey[]];

// Other plain-text elements (labels, captions, footer and header text...) are styled by their content path; text of an added section
// is keyed by the section's id, not its position, so reordering sections cannot move a look onto the wrong element.
export const TEXT_KEY = /^(?:[A-Za-z][A-Za-z0-9]*|custom:[a-z0-9]{6,24})(?:\.[A-Za-z0-9]+){0,5}$/;
export const MAX_TEXT_STYLES = 100;
export function textKey(path: string, customs: readonly { id: string }[]): string {
  const m = path.match(/^custom\.(\d+)(.*)$/);
  return m && customs[Number(m[1])] ? `custom:${customs[Number(m[1])].id}${m[2]}` : path;
}

export interface ContentStyles {
  // Per-card looks; they are laid over the shared `statCards` look.
  cards?: Partial<Record<CardKey, StatCardStyle>>;
  texts?: Record<string, HeadingStyle>;
  statCards?: StatCardStyle;
  headings?: Partial<Record<HeadingKey, HeadingStyle>>;
  buttons?: Partial<Record<ButtonKey, ButtonSettings>>;
  rows?: Partial<Record<RowKey, { align?: BoxAlign }>>;
  sections?: Partial<Record<BuiltinKey, SectionStyle>>;
}

// The destination a button really leads to, and whether the editor may change it.
export function buttonDestination(key: ButtonKey, s?: ButtonSettings): { href: string; locked: string | null; external: boolean; newTab: boolean } {
  const def = BUTTONS[key];
  const locked = "locked" in def ? def.locked : null;
  const href = locked ? def.defaultHref : (s?.href ?? def.defaultHref);
  const external = /^https?:\/\//i.test(href);
  return { href, locked, external, newTab: !locked && (!!s?.newTab || false) };
}

// ---- section order ---------------------------------------------------------------------------------------------------------------

export const BUILTIN_SECTIONS = [
  { key: "hero", label: "Hero", lock: "first", note: "The hero holds the page's main heading and first action, so it always stays first." },
  { key: "builtFor", label: "“Built for” strip" },
  { key: "register", label: "UK register section", note: "Figures here come from the database and cannot be edited, but the section can move." },
  { key: "source", label: "Official source card" },
  { key: "structure", label: "Corporate structure (planned)", note: "States what data is not held today; its wording is fixed in code, but the section can move." },
  { key: "search", label: "Search section" },
  { key: "filters", label: "Filters section" },
  { key: "workflow", label: "Reports & CRM section" },
  { key: "platform", label: "Platform cards" },
  { key: "apart", label: "What sets us apart" },
  { key: "api", label: "API section (planned)", dark: true, note: "States that the API is not available yet; its wording is fixed in code, but the section can move." },
  { key: "useCases", label: "Use cases" },
  { key: "faq", label: "FAQ" },
  { key: "finalCta", label: "Final call to action", lock: "last", dark: true, note: "The closing call to action always stays last, just above the footer." },
] as const satisfies readonly { key: string; label: string; lock?: "first" | "last"; dark?: boolean; note?: string }[];
export type BuiltinKey = (typeof BUILTIN_SECTIONS)[number]["key"];
export const BUILTIN_KEYS = BUILTIN_SECTIONS.map((s) => s.key) as [BuiltinKey, ...BuiltinKey[]];
export const isBuiltinKey = (k: string): k is BuiltinKey => (BUILTIN_KEYS as readonly string[]).includes(k);
export const DEFAULT_ORDER: readonly BuiltinKey[] = BUILTIN_KEYS;
export const sectionInfo = (k: BuiltinKey) => BUILTIN_SECTIONS.find((s) => s.key === k)!;
// The text colour the section uses by default (to warn about a background that would make it unreadable).
export const sectionTextColour = (k: BuiltinKey) => (("dark" in sectionInfo(k) ? "#ffffff" : "#0b2a6f"));

export type OrderKey = BuiltinKey | `custom:${string}`;
export const customKey = (id: string): OrderKey => `custom:${id}`;
export const isCustomKey = (k: string): k is `custom:${string}` => k.startsWith("custom:");

// Where an added section sits when the page has no explicit order: right after this built-in section.
const SLOT_ANCHOR: Record<SlotId, BuiltinKey> = { afterHero: "builtFor", afterRegister: "source", afterSearch: "search", afterWorkflow: "workflow", afterPlatform: "platform", beforeFaq: "useCases", afterFaq: "faq" };
export const slotAnchor = (slot: SlotId): BuiltinKey => SLOT_ANCHOR[slot];

// The default order, with each added section placed after its slot's anchor (same result as before explicit ordering existed).
export function defaultOrder(custom: readonly { id: string; slot: SlotId }[]): OrderKey[] {
  const out: OrderKey[] = [];
  for (const k of DEFAULT_ORDER) {
    out.push(k);
    for (const c of custom) if (SLOT_ANCHOR[c.slot] === k) out.push(customKey(c.id));
  }
  return out;
}

// null when `order` is a complete, legal order: every built-in section once, every added section once, hero first, call to action last.
export function validateOrder(order: readonly string[], customIds: readonly string[]): string | null {
  const want = new Set<string>([...BUILTIN_KEYS, ...customIds.map(customKey)]);
  if (order.length !== want.size) return "The section order must list every section exactly once.";
  const seen = new Set<string>();
  for (const k of order) {
    if (!want.has(k)) return `Unknown section in the order: ${k.slice(0, 40)}.`;
    if (seen.has(k)) return `A section appears twice in the order: ${k.slice(0, 40)}.`;
    seen.add(k);
  }
  if (order[0] !== "hero") return "The hero must stay first.";
  if (order[order.length - 1] !== "finalCta") return "The final call to action must stay last.";
  return null;
}

// What the page uses: the stored explicit order when it is valid, otherwise the default order.
export function resolveOrder(order: readonly string[] | undefined, custom: readonly { id: string; slot: SlotId }[]): OrderKey[] {
  if (order && validateOrder(order, custom.map((c) => c.id)) === null) return [...order] as OrderKey[];
  return defaultOrder(custom);
}

// Why this section cannot be dragged away from where it is, or null when it can move.
export function lockReason(key: OrderKey): string | null {
  if (isCustomKey(key)) return null;
  const s = sectionInfo(key);
  return "lock" in s ? s.note! : null;
}

// Moves `key` to `index` in the order (an index into the list as it is now), refusing to disturb the two fixed ends.
export function moveInOrder(order: readonly OrderKey[], key: OrderKey, toIndex: number): { order: OrderKey[]; error: string | null } {
  const from = order.indexOf(key);
  if (from < 0) return { order: [...order], error: "That section is not on the page." };
  const locked = lockReason(key);
  if (locked) return { order: [...order], error: locked };
  const lo = 1;
  const hi = order.length - 2;
  if (toIndex < lo) return { order: [...order], error: "Nothing can go above the hero." };
  if (toIndex > hi) return { order: [...order], error: "Nothing can go below the final call to action." };
  if (toIndex === from) return { order: [...order], error: null };
  const out = [...order];
  out.splice(from, 1);
  out.splice(toIndex, 0, key);
  return { order: out, error: null };
}

// ---- CSS builders ------------------------------------------------------------------------------------------------------------------

const rem = (px: number) => `${px / 16}rem`;

// Big sizes shrink with the screen width so a 72 px heading does not overflow a phone; small sizes stay exact.
export function fluidFontSize(px: number): string {
  if (px <= 28) return rem(px);
  return `clamp(${rem(Math.max(20, px * 0.5))}, ${(px / 6.5).toFixed(2)}vw, ${rem(px)})`;
}

const clean = (o: CSSProperties): CSSProperties | undefined => (Object.keys(o).length ? o : undefined);

export function headingCss(h?: HeadingStyle): CSSProperties | undefined {
  if (!h) return undefined;
  const o: CSSProperties = {};
  if (h.font) o.fontFamily = FONT_STACK[h.font];
  if (h.size !== undefined) o.fontSize = fluidFontSize(h.size);
  if (h.weight) o.fontWeight = WEIGHT_VALUE[h.weight];
  if (h.italic) o.fontStyle = "italic";
  if (h.color) o.color = h.color;
  if (h.align) o.textAlign = h.align;
  return clean(o);
}

// Look of one part of a two-part heading (a span inside the heading). Nothing when that part has no settings of its own.
export function partCss(h: HeadingStyle | undefined, part: "lead" | "accent"): CSSProperties | undefined {
  if (!h) return undefined;
  const o: CSSProperties = {};
  const font = part === "lead" ? h.leadFont : h.accentFont;
  const weight = part === "lead" ? h.leadWeight : h.accentWeight;
  const italic = part === "lead" ? h.leadItalic : h.accentItalic;
  if (font) o.fontFamily = FONT_STACK[font];
  if (weight) o.fontWeight = WEIGHT_VALUE[weight];
  if (italic) o.fontStyle = "italic";
  if (part === "accent" && h.accentColor) o.color = h.accentColor;
  return clean(o);
}

// The look of one card: the shared look with that card's own settings on top.
export function cardLook(styles: ContentStyles | undefined, key: CardKey): StatCardStyle | undefined {
  const a = key === "register" ? undefined : styles?.statCards; // the shared look is the six figure cards', not the large card's
  const b = styles?.cards?.[key];
  return a || b ? { ...a, ...b } : undefined;
}

export function statCardCss(s?: StatCardStyle): { card?: CSSProperties; value?: CSSProperties; label?: CSSProperties } {
  if (!s) return {};
  const card: CSSProperties = {};
  if (s.bg) card.backgroundColor = s.bg;
  if (s.borderColor || s.borderWidth !== undefined) {
    card.borderStyle = "solid";
    if (s.borderColor) card.borderColor = s.borderColor;
    if (s.borderWidth !== undefined) card.borderWidth = `${s.borderWidth}px`;
  }
  if (s.radius !== undefined) card.borderRadius = `${s.radius}px`;
  if (s.padX !== undefined) {
    card.paddingLeft = `${s.padX}px`;
    card.paddingRight = `${s.padX}px`;
  }
  if (s.padY !== undefined) {
    card.paddingTop = `${s.padY}px`;
    card.paddingBottom = `${s.padY}px`;
  }
  if (s.align) card.textAlign = s.align;
  const value: CSSProperties = {};
  if (s.valueColor) value.color = s.valueColor;
  if (s.valueSize !== undefined) value.fontSize = fluidFontSize(s.valueSize);
  if (s.valueWeight) value.fontWeight = WEIGHT_VALUE[s.valueWeight];
  if (s.valueFont) value.fontFamily = FONT_STACK[s.valueFont];
  if (s.valueItalic) value.fontStyle = "italic";
  const label: CSSProperties = {};
  if (s.labelColor) label.color = s.labelColor;
  if (s.labelSize !== undefined) label.fontSize = rem(s.labelSize);
  if (s.labelWeight) label.fontWeight = WEIGHT_VALUE[s.labelWeight];
  if (s.labelItalic) label.fontStyle = "italic";
  return { card: clean(card), value: clean(value), label: clean(label) };
}

export function buttonCss(b?: ButtonSettings): CSSProperties | undefined {
  if (!b) return undefined;
  const o: CSSProperties = {};
  if (b.font) o.fontFamily = FONT_STACK[b.font];
  if (b.size !== undefined) o.fontSize = rem(b.size);
  if (b.weight) o.fontWeight = WEIGHT_VALUE[b.weight];
  if (b.color) o.color = b.color;
  if (b.bg) o.backgroundColor = b.bg;
  if (b.borderColor || b.borderWidth !== undefined) {
    o.borderStyle = "solid";
    if (b.borderColor) o.borderColor = b.borderColor;
    if (b.borderWidth !== undefined) o.borderWidth = `${b.borderWidth}px`;
  }
  if (b.radius !== undefined) o.borderRadius = `${b.radius}px`;
  if (b.padX !== undefined || b.padY !== undefined) {
    if (b.padY !== undefined) {
      o.paddingTop = `${b.padY}px`;
      o.paddingBottom = `${b.padY}px`;
    }
    if (b.padX !== undefined) {
      o.paddingLeft = `${b.padX}px`;
      o.paddingRight = `${b.padX}px`;
    }
  }
  return clean(o);
}

// Button look including alignment for a button that sits alone (buttons in a row are aligned through their row).
export function buttonStyleFor(key: ButtonKey, b?: ButtonSettings): CSSProperties | undefined {
  const css = buttonCss(b);
  if (!b?.align || "row" in BUTTONS[key]) return css;
  return { ...css, display: "flex", width: "fit-content", marginLeft: b.align === "left" ? 0 : "auto", marginRight: b.align === "right" ? 0 : "auto" };
}

export function rowStyle(a?: BoxAlign): CSSProperties | undefined {
  return a ? { justifyContent: flexAlign(a), alignItems: flexAlign(a) } : undefined;
}

// `background` (the shorthand) replaces a section's gradient as well as its colour, which is what choosing a colour should do.
export function sectionCss(s?: SectionStyle): CSSProperties | undefined {
  if (!s) return undefined;
  const o: CSSProperties = {};
  if (s.bg) o.background = s.bg;
  if (s.padTop !== undefined) o.paddingTop = `${s.padTop}px`;
  if (s.padBottom !== undefined) o.paddingBottom = `${s.padBottom}px`;
  return clean(o);
}

export const flexAlign = (a: BoxAlign) => (a === "left" ? "flex-start" : a === "right" ? "flex-end" : "center");

export const hasImageDisplay = (d: ImageDisplay | undefined): d is ImageDisplay => !!d && Object.values(d).some((v) => v !== undefined);

// How an image is sized and placed, as styles for a wrapper (size, alignment, float) and the picture itself (fit, corners, border).
// The width is a ceiling: the image never overflows its container. With both a width and a height the picture keeps that
// proportion at every screen size and `fit` decides whether it is cropped (cover) or letterboxed (contain). A wrapped image floats
// beside the text from the `sm` breakpoint up; on a phone it is an ordinary centred block, so the layout cannot break.
export function imageCss(d: ImageDisplay, intrinsic?: { width?: number; height?: number }): { wrap: CSSProperties; img: CSSProperties; floatClass: string } {
  const wrap: CSSProperties = { display: "block" };
  const img: CSSProperties = { display: "block", width: "100%", height: "auto" };
  const w = d.displayWidth;
  const h = d.displayHeight;
  if (w !== undefined) {
    wrap.width = "100%";
    wrap.maxWidth = `${w}px`;
  } else if (h !== undefined && intrinsic?.width && intrinsic.height) {
    wrap.width = "100%";
    wrap.maxWidth = `${Math.round((h * intrinsic.width) / intrinsic.height)}px`;
  }
  if (w !== undefined && h !== undefined) {
    img.aspectRatio = `${w} / ${h}`;
    img.objectFit = d.fit ?? "cover";
  }
  if (d.radius !== undefined) img.borderRadius = `${d.radius}px`;
  if (d.borderWidth !== undefined || d.borderColor) {
    img.borderStyle = "solid";
    if (d.borderWidth !== undefined) img.borderWidth = `${d.borderWidth}px`;
    if (d.borderColor) img.borderColor = d.borderColor;
  }
  const align = d.align ?? "center";
  wrap.marginLeft = align === "left" ? 0 : "auto";
  wrap.marginRight = align === "right" ? 0 : "auto";
  const floatClass = d.wrap === "left" ? "sm:float-left sm:mr-6 sm:mb-3" : d.wrap === "right" ? "sm:float-right sm:ml-6 sm:mb-3" : "";
  if (floatClass) {
    wrap.marginLeft = "auto";
    wrap.marginRight = "auto";
    if (w === undefined) wrap.maxWidth = "min(100%, 20rem)";
  }
  return { wrap, img, floatClass };
}

// Removes the !important utility classes of a built-in button for the properties an editor has overridden (an inline colour would
// otherwise lose against them). With no override the class list is returned untouched.
export function stripOverridden(cls: string | undefined, css: CSSProperties | undefined, strip?: Partial<Record<"bg" | "color" | "border", string[]>>): string | undefined {
  if (!cls || !css || !strip) return cls;
  const drop = new Set<string>([...(css.backgroundColor ? (strip.bg ?? []) : []), ...(css.color ? (strip.color ?? []) : []), ...(css.borderColor || css.borderStyle ? (strip.border ?? []) : [])]);
  return drop.size ? cls.split(" ").filter((x) => !drop.has(x)).join(" ") : cls;
}
