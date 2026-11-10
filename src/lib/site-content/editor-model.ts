// Pure helpers for the visual editor: reading and writing content by path, describing what a clicked element is, and building
// new sections. No React, no DOM: everything here is unit-tested. The editor never builds HTML; it edits the same validated
// data the public page renders (the server validates everything again on save and on publish).

import { FIELD_MAX } from "./schema";
import type { CustomSectionContent, EditableContent } from "./schema";
import { runsText, type Run } from "./rich";
import { CTA_TARGETS, SECTION_TYPES, type SectionType, type SlotId } from "./sections";
import { isCardKey, type CardImageTarget, type CardKey, type ImageRef, STAT_LABEL_DEFAULTS, STAT_LABEL_KEYS, isStatLabelKey, type StatLabelKey, BUILTIN_KEYS as BUILTIN_KEY_LIST, buttonForLabelPath, defaultOrder, isCustomKey, isHeadingKey, customKey, moveInOrder, resolveOrder, sectionInfo, slotAnchor, type BuiltinKey, type ButtonKey, type HeadingKey, type OrderKey } from "./styles";

export type Path = (string | number)[];
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export const parsePath = (p: string): Path => p.split(".").map((s) => (/^\d+$/.test(s) ? Number(s) : s));
export const pathKey = (p: Path) => p.join(".");

export function getIn(o: unknown, path: Path): unknown {
  let cur: unknown = o;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}

// Immutable write. Missing containers on the way are an error (the editor only writes to paths that exist).
export function setIn<T>(o: T, path: Path, value: unknown): T {
  if (path.length === 0) return value as T;
  const [head, ...rest] = path;
  if (Array.isArray(o)) return o.map((v, i) => (i === head ? setIn(v, rest, value) : v)) as unknown as T;
  const obj = o as Record<string, unknown>;
  return { ...obj, [head]: setIn(obj[head as string], rest, value) } as T;
}

// Removes an object key (used when an optional field is cleared).
export function removeKey<T>(o: T, path: Path): T {
  const parent = path.slice(0, -1);
  const key = path[path.length - 1];
  const container = getIn(o, parent) as Record<string, unknown>;
  const { [key as string]: _gone, ...rest } = container; // eslint-disable-line @typescript-eslint/no-unused-vars
  return setIn(o, parent, rest);
}

export const insertAt = <T>(list: readonly T[], index: number, item: T): T[] => [...list.slice(0, index), item, ...list.slice(index)];
export const removeAt = <T>(list: readonly T[], index: number): T[] => list.filter((_, i) => i !== index);
export function move<T>(list: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return [...list];
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

// ---- what is this path? ------------------------------------------------------------------------------------------------------

const RICH_PATHS = [
  /^hero\.intro$/,
  /^ukRegister\.intro$/,
  /^officialSource\.text$/,
  /^filters\.text$/,
  /^workflow\.text$/,
  /^workflow\.tabs\.[a-z]+\.text$/,
  /^platform\.text$/,
  /^platform\.cards\.\d+\.text$/,
  /^apart\.talk\.text$/,
  /^apart\.items\.\d+\.text$/,
  /^useCases\.text$/,
  /^useCases\.items\.\d+\.text$/,
  /^faq\.items\.\d+\.a$/,
  /^finalCta\.text$/,
  /^custom\.\d+\.(text|intro)$/,
  /^custom\.\d+\.cards\.\d+\.text$/,
  /^custom\.\d+\.items\.\d+\.a$/,
];
export const isRichPath = (p: string) => RICH_PATHS.some((re) => re.test(p));

// Names of what one string in a list is, to look up its length limit.
const ITEM_FIELD: Record<string, string> = { audiences: "audience", fields: "field", bullets: "bullet", steps: "step" };

// Lists whose length the editor may change: [min, max]. Everything else has a fixed length.
export function listBounds(listPath: Path): [number, number] | null {
  const key = pathKey(listPath);
  const last = listPath[listPath.length - 1];
  if (last === "audiences") return [3, 8];
  if (last === "fields") return [1, 8];
  if (last === "bullets") return [1, 6];
  if (key === "faq.items") return [1, 8];
  if (/^custom\.\d+\.cards$/.test(key)) return [1, 6];
  if (/^custom\.\d+\.items$/.test(key)) return [1, 8];
  if (/^custom\.\d+\.blocks$/.test(key)) return [1, 12];
  return null;
}

export type Desc =
  | { kind: "plain"; label: string; max: number; multiline: boolean; optional: boolean; list?: { path: Path; index: number; min: number; max: number }; heading?: HeadingRef }
  | { kind: "rich"; label: string; max: number; optional: boolean }
  | { kind: "headingParts"; label: string; heading?: HeadingRef }
  | { kind: "section"; index: number }
  | { kind: "block"; section: number; block: number }
  | { kind: "builtinSection"; key: BuiltinKey }
  | { kind: "button"; button: ButtonKey }
  | { kind: "customButton"; section: number }
  | { kind: "statLabel"; key: StatLabelKey }
  | { kind: "statCard"; card: CardKey }
  | { kind: "cardImage"; target: CardImageTarget }
  | { kind: "none" };

// Which stored appearance settings a heading's text uses: the built-in heading's key, or the `headingStyle` of an added section.
export type HeadingRef = { builtin: HeadingKey } | { custom: number };

const LABELS: Record<string, string> = {
  lead: "Heading, first part",
  accent: "Heading, highlighted part",
  intro: "Intro text",
  eyebrow: "Small heading above",
  heading: "Heading",
  text: "Text",
  title: "Title",
  badge: "Badge",
  tag: "Tag",
  hint: "Search box text",
  label: "Label",
  tryLabel: "Button label",
  ctaLabel: "Button label",
  buttonLabel: "Button label",
  primaryCtaLabel: "Main button",
  secondaryCtaLabel: "Second button",
  primaryLabel: "Main button",
  secondaryLabel: "Second button",
  q: "Question",
  a: "Answer",
  tagline: "Tagline",
  sectionsTitle: "Links heading",
  audiences: "Audience",
  fields: "Field name",
  bullets: "Bullet point",
  steps: "Step",
  caption: "Caption",
  alt: "Image description (alt text)",
};
const SECTION_NAMES: Record<string, string> = {
  hero: "Hero",
  builtFor: "“Built for” strip",
  ukRegister: "UK register section",
  officialSource: "Official source card",
  search: "Search section",
  filters: "Filters section",
  workflow: "Reports & CRM section",
  platform: "Platform cards",
  apart: "What sets us apart",
  useCases: "Use cases",
  faq: "FAQ",
  finalCta: "Final call to action",
  header: "Header",
  footer: "Footer",
};

export function sectionName(path: Path): string {
  if (path[0] === "custom") return "Added section";
  return SECTION_NAMES[String(path[0])] ?? String(path[0]);
}

const humanize = (k: string) => LABELS[k] ?? k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());

export function labelFor(path: Path): string {
  const last = path[path.length - 1];
  const parent = path[path.length - 2];
  if (typeof last === "number") return `${humanize(String(parent))} ${last + 1}`;
  const base = humanize(String(last));
  const owner = path.slice(0, -1).reverse().find((x) => typeof x === "number");
  return typeof owner === "number" ? `${base} (item ${owner + 1})` : base;
}

export function describePath(content: EditableContent, p: string): Desc {
  const sec = p.match(/^section:(\w+)$/);
  if (sec) return sectionInfoExists(sec[1]) ? { kind: "builtinSection", key: sec[1] as BuiltinKey } : { kind: "none" };
  const card = p.match(/^card:(?:stat\.(\w+)|(register))$/);
  if (card) {
    const k = card[1] ?? card[2];
    return isCardKey(k) ? { kind: "statCard", card: k } : { kind: "none" };
  }
  const img = p.match(/^image:(circle|useCase)\.(\d+)$/);
  if (img) {
    const i = Number(img[2]);
    if (img[1] === "circle") return i < 3 ? { kind: "cardImage", target: { type: "circle", index: i as 0 | 1 | 2 } } : { kind: "none" };
    return i < content.useCases.items.length ? { kind: "cardImage", target: { type: "useCase", index: i } } : { kind: "none" };
  }
  const lab = p.match(/^ukRegister\.labels\.(\w+)$/);
  if (lab) return isStatLabelKey(lab[1]) ? { kind: "statLabel", key: lab[1] } : { kind: "none" };
  const path = parsePath(p);
  const value = getIn(content, path);
  if (value === undefined) return { kind: "none" };

  const btn = buttonForLabelPath(p);
  if (btn) return { kind: "button", button: btn };
  const cta = p.match(/^custom\.(\d+)\.buttonLabel$/);
  if (cta) return { kind: "customButton", section: Number(cta[1]) };
  const customHeading = p.match(/^custom\.(\d+)\.(title|heading)$/);
  const heading: HeadingRef | undefined = isHeadingKey(p) ? { builtin: p } : customHeading && content.custom[Number(customHeading[1])]?.type !== "video" ? { custom: Number(customHeading[1]) } : undefined;

  let m = p.match(/^custom\.(\d+)$/);
  if (m) return { kind: "section", index: Number(m[1]) };
  m = p.match(/^custom\.(\d+)\.blocks\.(\d+)$/);
  if (m) return { kind: "block", section: Number(m[1]), block: Number(m[2]) };

  if (value && typeof value === "object" && !Array.isArray(value) && "lead" in value && "accent" in value) return { kind: "headingParts", label: labelFor(path), ...(heading ? { heading } : {}) };

  const optional = /^custom\.\d+\.(title|caption|heading|intro|text)$/.test(p) && !/^custom\.\d+\.cards\./.test(p) && !isCtaRequired(content, p);
  if (isRichPath(p)) return { kind: "rich", label: labelFor(path), max: FIELD_MAX[String(path[path.length - 1])] ?? 400, optional };

  if (typeof value === "string") {
    const last = path[path.length - 1];
    const parent = path[path.length - 2];
    const maxName = typeof last === "number" ? (ITEM_FIELD[String(parent)] ?? String(parent)) : String(last);
    const max = maxName === "title" && /^custom\.\d+\.title$/.test(p) ? FIELD_MAX.title : (FIELD_MAX[maxName] ?? 400);
    let list: { path: Path; index: number; min: number; max: number } | undefined;
    if (typeof last === "number") {
      const b = listBounds(path.slice(0, -1));
      list = { path: path.slice(0, -1), index: last, min: b?.[0] ?? 0, max: b?.[1] ?? 0 };
    }
    return { kind: "plain", label: labelFor(path), max, multiline: max > 120, optional, list, ...(heading ? { heading } : {}) };
  }
  return { kind: "none" };
}

// A cta section's heading is required; only the other optional-looking fields can be cleared.
function isCtaRequired(content: EditableContent, p: string): boolean {
  const m = p.match(/^custom\.(\d+)\.(.+)$/);
  if (!m) return false;
  const s = content.custom[Number(m[1])];
  if (!s) return false;
  const field = m[2];
  if (field === "heading") return s.type === "cta" || s.type === "faq";
  if (field === "title") return false;
  return false;
}

// ---- new sections ------------------------------------------------------------------------------------------------------------

export function newId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 12);
}

const run = (text: string): Run[] => [{ text }];

export type NewSectionInput =
  | { type: "text" }
  | { type: "cta" }
  | { type: "cards" }
  | { type: "faq" }
  | { type: "image"; mediaId: string; alt: string; width?: number; height?: number }
  | { type: "video"; provider: "youtube" | "vimeo"; videoId: string };

// A new section starts with clearly marked placeholder wording that already passes validation, so it can be saved at once.
export function newSection(input: NewSectionInput, slot: SlotId): CustomSectionContent {
  const id = newId();
  switch (input.type) {
    case "text":
      return { id, slot, type: "text", title: "New section heading", blocks: [{ kind: "p", runs: run("Write your text here. Select any words to make them bold, italic, coloured or a link.") }] };
    case "cta":
      return { id, slot, type: "cta", heading: "Ready to get started?", text: "Sign in to start searching, filtering and building reports.", buttonLabel: "Sign in", target: CTA_TARGETS[0].id, tone: "brand" };
    case "cards":
      return { id, slot, type: "cards", heading: "Highlights", cards: [1, 2, 3].map((n) => ({ title: `Feature ${n}`, text: "Describe this feature in a sentence." })) };
    case "faq":
      return { id, slot, type: "faq", heading: "Frequently asked questions", items: [{ q: "Your first question?", a: "Your answer." }] };
    case "image":
      return { id, slot, type: "image", mediaId: input.mediaId, alt: input.alt, size: "medium", ...(input.width && input.height ? { width: input.width, height: input.height } : {}) };
    case "video":
      return { id, slot, type: "video", provider: input.provider, videoId: input.videoId, title: "Video" };
  }
}

export type Block = Extract<CustomSectionContent, { type: "text" }>["blocks"][number];

export function newBlock(kind: "p" | "h2" | "h3" | "ul" | "ol"): Block {
  if (kind === "ul" || kind === "ol") return { kind, items: [run("First item"), run("Second item")] };
  return { kind, runs: run(kind === "p" ? "New paragraph." : kind === "h2" ? "New heading" : "New sub-heading") };
}

// Duplicate with a fresh id (and fresh nothing else: everything else is plain data).
export function duplicateSection(s: CustomSectionContent): CustomSectionContent {
  return { ...JSON.parse(JSON.stringify(s)), id: newId() };
}

// Optional text left empty in the editor means "remove it": the server rejects empty text, so these are dropped before saving.
export function pruneEmptyOptionals(c: EditableContent): EditableContent {
  const empty = (v: unknown) => v === undefined || (typeof v === "string" && v.trim() === "") || (typeof v === "object" && v !== null && "runs" in v && runsText((v as { runs: Run[] }).runs).trim() === "");
  const drop = <T extends Record<string, unknown>>(o: T, keys: string[]): T => {
    const out: Record<string, unknown> = { ...o };
    for (const k of keys) if (k in out && empty(out[k])) delete out[k];
    return out as T;
  };
  return {
    ...c,
    custom: c.custom.map((s) => {
      if (s.type === "text") return drop(s, ["title"]);
      if (s.type === "image" || s.type === "video") return drop(s, ["caption"]);
      if (s.type === "cta") return drop(s, ["text"]);
      if (s.type === "cards") return drop(s, ["heading", "intro"]);
      return s;
    }),
  };
}

// ---- an outline of every editable text on the page (for keyboard users, and for text that is not on screen) -------------------------

export interface OutlineItem {
  path: string;
  label: string;
  preview: string;
}

const snippet = (s: string) => (s.length > 70 ? `${s.slice(0, 67)}…` : s);

// Every editable text of the built-in sections, grouped by section, in page order. A heading made of two parts is one item (they
// are edited together). Added sections are not listed here: they have their own list.
export function outline(content: EditableContent): { section: string; items: OutlineItem[] }[] {
  const groups: { section: string; items: OutlineItem[] }[] = [];
  for (const key of Object.keys(content)) {
    if (key === "custom" || key === "styles" || key === "order") continue;
    const items: OutlineItem[] = [];
    const walk = (value: unknown, path: Path) => {
      if (typeof value === "string") {
        items.push({ path: pathKey(path), label: labelFor(path), preview: snippet(value) });
      } else if (Array.isArray(value)) {
        value.forEach((v, i) => walk(v, [...path, i]));
      } else if (value && typeof value === "object") {
        const o = value as Record<string, unknown>;
        if ("runs" in o) items.push({ path: pathKey(path), label: labelFor(path), preview: snippet(runsText(o.runs as Run[])) });
        else if ("lead" in o && "accent" in o) items.push({ path: pathKey(path), label: labelFor(path), preview: snippet(`${o.lead} ${o.accent}`) });
        else for (const k of Object.keys(o)) walk(o[k], [...path, k]);
      }
    };
    walk((content as unknown as Record<string, unknown>)[key], [key]);
    if (key === "ukRegister") {
      // The captions of the figure cards are editable even while they still have their built-in wording.
      const set = content.ukRegister.labels ?? {};
      for (const k of STAT_LABEL_KEYS) if (!(k in set)) items.push({ path: `ukRegister.labels.${k}`, label: `Card caption: ${STAT_LABEL_DEFAULTS[k]}`, preview: snippet(STAT_LABEL_DEFAULTS[k]) });
    }
    groups.push({ section: sectionName([key]), items });
  }
  return groups;
}

// ---- appearance settings and section order (see styles.ts) ------------------------------------------------------------------------

export type StyleGroup = "headings" | "buttons" | "rows" | "sections" | "texts" | "cards";

type Bag = Record<string, unknown>;

// The settings stored for one element ({} when none).
export function styleOf<T extends object = Bag>(c: EditableContent, group: StyleGroup, key: string): T {
  const g = (c.styles as unknown as Record<string, Record<string, Bag> | undefined> | undefined)?.[group];
  return ((g?.[key] ?? {}) as unknown) as T;
}

// Sets or clears (undefined) individual settings of one element; empty settings and empty groups are removed, so a content object
// with default appearance has no `styles` key at all.
export function patchStyle(c: EditableContent, group: StyleGroup, key: string, patch: object): EditableContent {
  const styles = { ...((c.styles ?? {}) as unknown as Record<string, Record<string, Bag>>) };
  const g = { ...(styles[group] ?? {}) };
  const cur: Bag = { ...(g[key] ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete cur[k];
    else cur[k] = v;
  }
  if (Object.keys(cur).length) g[key] = cur;
  else delete g[key];
  if (Object.keys(g).length) styles[group] = g;
  else delete styles[group];
  const { styles: _old, ...rest } = c; // eslint-disable-line @typescript-eslint/no-unused-vars
  return Object.keys(styles).length ? ({ ...rest, styles } as EditableContent) : rest;
}

export const resetStyle = (c: EditableContent, group: StyleGroup, key: string): EditableContent => patchStyle(c, group, key, Object.fromEntries(Object.keys(styleOf(c, group, key)).map((k) => [k, undefined])));

// Same for a field object that lives on an added section (its `style`, `headingStyle` or `button`).
export function patchCustomField(c: EditableContent, index: number, field: "style" | "headingStyle" | "button", patch: object): EditableContent {
  return {
    ...c,
    custom: c.custom.map((s, i) => {
      if (i !== index) return s;
      const cur: Bag = { ...(((s as unknown as Bag)[field] as Bag | undefined) ?? {}) };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete cur[k];
        else cur[k] = v;
      }
      const next = { ...(s as unknown as Bag) };
      if (Object.keys(cur).length) next[field] = cur;
      else delete next[field];
      return next as unknown as CustomSectionContent;
    }),
  };
}

// The order the page uses now (the stored explicit order, or the default).
export const currentOrder = (c: Pick<EditableContent, "order" | "custom">): OrderKey[] => resolveOrder(c.order, c.custom);

const sameOrder = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k, i) => k === b[i]);

// Stores an order. An order identical to the default is not stored at all (the content stays canonical).
export function withOrder(c: EditableContent, order: readonly OrderKey[]): EditableContent {
  const { order: _old, ...rest } = c; // eslint-disable-line @typescript-eslint/no-unused-vars
  return sameOrder(order, defaultOrder(c.custom)) ? rest : { ...rest, order: [...order] };
}

export const resetOrder = (c: EditableContent): EditableContent => withOrder(c, defaultOrder(c.custom));

// Moves one section so that it ends up at `finalIndex` of the new order. Refuses (with the reason) to move a fixed section or to put
// anything above the hero or below the final call to action.
export function moveSection(c: EditableContent, key: OrderKey, finalIndex: number): { content: EditableContent; error: string | null } {
  const r = moveInOrder(currentOrder(c), key, finalIndex);
  return r.error ? { content: c, error: r.error } : { content: withOrder(c, r.order), error: null };
}

export function moveSectionBy(c: EditableContent, key: OrderKey, dir: -1 | 1): { content: EditableContent; error: string | null } {
  const order = currentOrder(c);
  const i = order.indexOf(key);
  return moveSection(c, key, i + dir);
}

// A drop position in a list of `n` rows is a gap 0..n (before row 0 ... after the last row); the section lands at this index.
export const finalIndexForGap = (from: number, gap: number) => (gap > from ? gap - 1 : gap);

// Where an added section goes in an explicit order: right after the last section already sitting in its slot, or after the built-in
// section the slot is anchored to.
function insertionPoint(order: readonly OrderKey[], customs: readonly { id: string; slot: SlotId }[], slot: SlotId, skipId?: string): number {
  const anchor = order.indexOf(slotAnchor(slot));
  let at = anchor + 1;
  while (at < order.length) {
    const k = order[at];
    const c = isCustomKey(k) ? customs.find((x) => customKey(x.id) === k) : undefined;
    if (!c || c.slot !== slot || c.id === skipId) break;
    at++;
  }
  return at;
}

// Adding, removing and re-slotting an added section keep an explicit order valid (they are no-ops while the order is the default).
export function addCustomSection(c: EditableContent, section: CustomSectionContent, index: number, after?: OrderKey): EditableContent {
  const custom = insertAt(c.custom, index, section);
  if (!c.order) return { ...c, custom };
  const order = [...c.order] as OrderKey[];
  const at = after ? order.indexOf(after) + 1 : insertionPoint(order, custom, section.slot, section.id);
  order.splice(Math.max(1, Math.min(at, order.length - 1)), 0, customKey(section.id));
  return withOrder({ ...c, custom }, order);
}

export function removeCustomSection(c: EditableContent, index: number): EditableContent {
  const gone = c.custom[index];
  const custom = removeAt(c.custom, index);
  if (!gone || !c.order) return { ...c, custom };
  return withOrder({ ...c, custom }, (c.order as OrderKey[]).filter((k) => k !== customKey(gone.id)));
}

export function setSectionSlot(c: EditableContent, index: number, slot: SlotId): EditableContent {
  const s = c.custom[index];
  if (!s) return c;
  const custom = c.custom.map((x, i) => (i === index ? ({ ...x, slot } as CustomSectionContent) : x));
  if (!c.order) return { ...c, custom };
  const order = (c.order as OrderKey[]).filter((k) => k !== customKey(s.id));
  order.splice(insertionPoint(order, custom, slot), 0, customKey(s.id));
  return withOrder({ ...c, custom }, order);
}

// A readable name for a row of the section list.
export function sectionLabel(c: EditableContent, key: OrderKey): string {
  if (!isCustomKey(key)) return sectionInfo(key).label;
  const s = c.custom.find((x) => customKey(x.id) === key);
  if (!s) return "Added section";
  const title = "title" in s && typeof s.title === "string" ? s.title : "heading" in s && typeof s.heading === "string" ? s.heading : "";
  return `${SECTION_TYPES.find((t) => t.type === s.type)?.label ?? "Section"}${title ? `: ${title}` : ""}`.slice(0, 70);
}

const sectionInfoExists = (k: string) => (BUILTIN_KEY_LIST as readonly string[]).includes(k);

// ---- generic field patches on added sections ---------------------------------------------------------------------------------------

function applyPatch<T extends object>(o: T, patch: object): T {
  const out: Bag = { ...(o as unknown as Bag) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out as unknown as T;
}

// Sets (or, with undefined, removes) fields of one added section.
export const patchCustom = (c: EditableContent, index: number, patch: object): EditableContent => ({ ...c, custom: c.custom.map((s, i) => (i === index ? applyPatch(s, patch) : s)) });

// Same for one block of a text section.
export const patchBlock = (c: EditableContent, section: number, block: number, patch: object): EditableContent => ({
  ...c,
  custom: c.custom.map((s, i) => (i === section && s.type === "text" ? { ...s, blocks: s.blocks.map((b, j) => (j === block ? applyPatch(b, patch) : b)) } : s)),
});

export function newImageBlock(input: { mediaId: string; alt: string; width?: number; height?: number }): Block {
  return { kind: "image", mediaId: input.mediaId, alt: input.alt, ...(input.width && input.height ? { width: input.width, height: input.height } : {}) };
}

// ---- figure-card captions and look ----------------------------------------------------------------------------------------------------

// Sets one caption (undefined or empty goes back to the built-in wording; the object disappears when nothing is left).
export function setStatLabel(c: EditableContent, key: StatLabelKey, value: string | undefined): EditableContent {
  const labels = { ...(c.ukRegister.labels ?? {}) } as Record<string, string>;
  if (value === undefined || value === "") delete labels[key];
  else labels[key] = value;
  const { labels: _old, ...rest } = c.ukRegister; // eslint-disable-line @typescript-eslint/no-unused-vars
  return { ...c, ukRegister: Object.keys(labels).length ? { ...rest, labels: labels as typeof c.ukRegister.labels } : rest };
}

export function patchStatCards(c: EditableContent, patch: object): EditableContent {
  const cur: Bag = { ...((c.styles?.statCards ?? {}) as unknown as Bag) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete cur[k];
    else cur[k] = v;
  }
  const { statCards: _old, ...others } = (c.styles ?? {}) as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unused-vars
  const styles = Object.keys(cur).length ? { ...others, statCards: cur } : others;
  const { styles: _s, ...rest } = c; // eslint-disable-line @typescript-eslint/no-unused-vars
  return Object.keys(styles).length ? ({ ...rest, styles } as EditableContent) : rest;
}

// ---- pictures in the design's picture slots ----------------------------------------------------------------------------------------------

export function getCardImage(c: EditableContent, t: CardImageTarget): ImageRef | undefined {
  return t.type === "circle" ? (c.apart.circles as Record<string, ImageRef> | undefined)?.[String(t.index)] : c.useCases.items[t.index]?.image;
}

// Sets (or, with undefined, removes) the picture of one slot; empty containers disappear again.
export function setCardImage(c: EditableContent, t: CardImageTarget, ref: ImageRef | undefined): EditableContent {
  if (t.type === "useCase") {
    return { ...c, useCases: { ...c.useCases, items: c.useCases.items.map((it, i) => {
      if (i !== t.index) return it;
      const { image: _old, ...rest } = it; // eslint-disable-line @typescript-eslint/no-unused-vars
      return ref ? { ...rest, image: ref } : rest;
    }) } };
  }
  const circles = { ...((c.apart.circles ?? {}) as Record<string, ImageRef>) };
  if (ref) circles[String(t.index)] = ref;
  else delete circles[String(t.index)];
  const { circles: _o, ...rest } = c.apart; // eslint-disable-line @typescript-eslint/no-unused-vars
  return { ...c, apart: Object.keys(circles).length ? { ...rest, circles: circles as typeof c.apart.circles } : rest };
}

export function newButtonBlock(): Block {
  return { kind: "button", label: "Learn more", href: "#uk-data" };
}
export function newVideoBlock(v: { provider: "youtube" | "vimeo"; videoId: string }): Block {
  return { kind: "video", provider: v.provider, videoId: v.videoId, title: "Video" };
}
