import { z } from "zod";
import { DEFAULT_SITE_CONTENT } from "./defaults";
import { PROTECTED_FAQ } from "./protected-claims";
import { HEX } from "./colour";
import { ALIGNS, BOX_WIDTH_RANGE, COLORS, FONTS, LINE_HEIGHT_RANGE, MAX_FONT_PX, MAX_RUNS, MIN_FONT_PX, PAD_X_RANGE, SIZES, SPACE_AFTER_RANGE, SPACE_BEFORE_RANGE, makeRich, normalizeRuns, richPlain, runsText, validateHref, type BlockProps, type Run } from "./rich";
import { CTA_TARGET_IDS, MAX_CUSTOM_SECTIONS, MEDIA_ID, SLOT_IDS, VIDEO_ID, VIDEO_PROVIDERS } from "./sections";
import { BOX_ALIGNS, BUILTIN_KEYS, BUTTONS, BUTTON_KEYS, CARD_KEYS, HEADING_KEYS, LIMITS, MAX_TEXT_STYLES, ROW_KEYS, STAT_LABEL_KEYS, TEXT_KEY, WEIGHTS, validateOrder, type ContentStyles } from "./styles";

export { toEditable, applyEditable } from "./compose";

// The ONLY shape stored CMS content may have. Everything is `.strict()` (unknown keys are rejected), every text has a length
// cap, every list has a count, and all text is plain or structured: no markup characters, no control or bidirectional-control
// characters, NFC-normalised and trimmed. Formatting is data (see rich.ts): marks, palette colours, sizes and validated links.
//
// What cannot be expressed here cannot be edited: there are no keys for statistics, the Corporate structure and API sections,
// the hero's API note, the protected FAQ answers, the filter-field count, built-in link destinations, icons or colours.
// Link destinations for the header and footer come from the built-in defaults by position; only their labels are editable.
// Counts of built-in cards, items and tabs equal what the page's code supports today. Custom sections are limited to the
// section types and slots in sections.ts.

// Bumped when the stored shape changes incompatibly. Stored content with another version is never rendered (see reader.ts).
// Adding the optional `custom` list and rich values is backwards compatible: content stored before them still validates.
export const CURRENT_SCHEMA_VERSION = 1;

// Largest accepted content object, serialised (bytes). The database enforces a looser 128 KiB.
export const MAX_CONTENT_BYTES = 96 * 1024;
export const MAX_NOTE_LENGTH = 200;

// Maximum length (of the visible text) by field name; the editor uses the same table for its inputs.
export const FIELD_MAX: Record<string, number> = {
  label: 40,
  sectionsTitle: 40,
  tagline: 160,
  lead: 80,
  accent: 60,
  intro: 400,
  eyebrow: 80,
  heading: 160,
  text: 400,
  title: 100,
  badge: 40,
  tag: 40,
  hint: 120,
  tryLabel: 40,
  ctaLabel: 40,
  primaryCtaLabel: 40,
  secondaryCtaLabel: 40,
  primaryLabel: 40,
  secondaryLabel: 40,
  q: 160,
  a: 1200,
  audience: 40,
  field: 40,
  bullet: 140,
  step: 60,
  alt: 160,
  caption: 200,
  videoTitle: 120,
  blockText: 1200,
  statLabel: 60,
  listItem: 200,
};

// eslint-disable-next-line no-control-regex -- the point is to refuse control characters
const FORBIDDEN = new RegExp("[\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u2028-\\u202E\\u2060-\\u206F\\uFEFF<>]");
const PLAIN_RULE = "Plain text only: no line breaks, markup characters (< >) or control characters.";

function text(name: keyof typeof FIELD_MAX) {
  const max = FIELD_MAX[name];
  return z
    .string()
    .max(max * 4, `Too long (at most ${max} characters).`) // bounds the work before normalising
    .transform((s) => s.normalize("NFC").trim())
    .pipe(
      z
        .string()
        .min(1, "Cannot be empty.")
        .max(max, `Too long (at most ${max} characters).`)
        .refine((s) => !FORBIDDEN.test(s), PLAIN_RULE)
    );
}

// ---- rich text and runs ------------------------------------------------------------------------------------------------------

const BLOCK_KEY_SET = new Set(["lineHeight", "spaceAfter", "spaceBefore", "padX", "boxWidth", "boxAlign"]);
const RUN_KEYS = new Set(["text", "b", "i", "u", "color", "bg", "size", "font", "href"]);
const MAX_RUN_TEXT = 1200;

// Validates one untrusted run; returns the clean run or a message.
function checkRun(raw: unknown): { run: Run } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Each piece of text must be an object." };
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!RUN_KEYS.has(k)) return { error: `Unknown formatting field: ${k}.` };
  if (typeof o.text !== "string") return { error: "Text is required." };
  const t = o.text.normalize("NFC");
  if (t.length > MAX_RUN_TEXT) return { error: `A piece of text is too long (at most ${MAX_RUN_TEXT} characters).` };
  if (FORBIDDEN.test(t)) return { error: PLAIN_RULE };
  const run: Run = { text: t };
  for (const m of ["b", "i", "u"] as const) {
    if (o[m] === undefined) continue;
    if (o[m] !== true) return { error: `Formatting "${m}" must be true or absent.` };
    run[m] = true;
  }
  // A colour is a legacy palette key or a six-digit hex value; nothing else can reach a style.
  for (const k of ["color", "bg"] as const) {
    const v = o[k];
    if (v === undefined) continue;
    const lower = typeof v === "string" ? v.toLowerCase() : "";
    if (HEX.test(lower)) run[k] = lower;
    else if (k === "color" && (COLORS as readonly unknown[]).includes(v)) run.color = v as string;
    else return { error: "Use a six-digit colour such as #2457e8." };
  }
  if (o.size !== undefined) {
    if ((SIZES as readonly unknown[]).includes(o.size)) run.size = o.size as Run["size"];
    else if (typeof o.size === "number" && Number.isInteger(o.size) && o.size >= MIN_FONT_PX && o.size <= MAX_FONT_PX) run.size = o.size;
    else return { error: `Text size must be between ${MIN_FONT_PX} and ${MAX_FONT_PX} pixels.` };
  }
  if (o.font !== undefined) {
    if (!(FONTS as readonly unknown[]).includes(o.font)) return { error: "That font is not available." };
    run.font = o.font as Run["font"];
  }
  if (o.href !== undefined) {
    if (typeof o.href !== "string") return { error: "A link must be text." };
    const bad = validateHref(o.href);
    if (bad) return { error: bad };
    run.href = o.href;
  }
  return { run };
}

// Line height and the space after a paragraph, within safe limits.
function checkBlockProps(o: Record<string, unknown>): { block: BlockProps } | { error: string } {
  const block: BlockProps = {};
  if (o.lineHeight !== undefined) {
    const [lo, hi] = LINE_HEIGHT_RANGE;
    if (typeof o.lineHeight !== "number" || !Number.isFinite(o.lineHeight) || o.lineHeight < lo || o.lineHeight > hi) return { error: `Line height must be between ${lo} and ${hi}.` };
    block.lineHeight = Math.round(o.lineHeight * 100) / 100;
  }
  if (o.spaceAfter !== undefined) {
    const [lo, hi] = SPACE_AFTER_RANGE;
    if (typeof o.spaceAfter !== "number" || !Number.isInteger(o.spaceAfter) || o.spaceAfter < lo || o.spaceAfter > hi) return { error: `Space after a paragraph must be a whole number between ${lo} and ${hi} pixels.` };
    block.spaceAfter = o.spaceAfter;
  }
  const intIn = (k: "spaceBefore" | "padX" | "boxWidth", [lo, hi]: readonly [number, number], what: string): string | null => {
    if (o[k] === undefined) return null;
    if (typeof o[k] !== "number" || !Number.isInteger(o[k]) || (o[k] as number) < lo || (o[k] as number) > hi) return `${what} must be a whole number between ${lo} and ${hi}.`;
    block[k] = o[k] as number;
    return null;
  };
  const bad = intIn("spaceBefore", SPACE_BEFORE_RANGE, "Space before a paragraph") ?? intIn("padX", PAD_X_RANGE, "Side padding") ?? intIn("boxWidth", BOX_WIDTH_RANGE, "Width (percent)");
  if (bad) return { error: bad };
  if (o.boxAlign !== undefined) {
    if (!(BOX_ALIGNS as readonly unknown[]).includes(o.boxAlign)) return { error: "Position must be left, centre or right." };
    block.boxAlign = o.boxAlign as BlockProps["boxAlign"];
  }
  return { block };
}

function checkRuns(raw: unknown, max: number): { runs: Run[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: "Expected formatted text." };
  if (raw.length > MAX_RUNS) return { error: `Too many formatting changes (at most ${MAX_RUNS} pieces).` };
  const runs: Run[] = [];
  for (const r of raw) {
    const c = checkRun(r);
    if ("error" in c) return c;
    runs.push(c.run);
  }
  const clean = normalizeRuns(runs);
  const length = runsText(clean).length;
  if (length === 0) return { error: "Cannot be empty." };
  if (length > max) return { error: `Too long (at most ${max} characters).` };
  return { runs: clean };
}

// A paragraph-like value: a plain string, or { runs, align? }. Canonical output (a string whenever nothing is formatted).
function richField(name: keyof typeof FIELD_MAX) {
  const max = FIELD_MAX[name];
  return z.unknown().transform((v, ctx) => {
    const fail = (message: string) => {
      ctx.addIssue({ code: "custom", message });
      return z.NEVER;
    };
    if (typeof v === "string") {
      if (v.length > max * 4) return fail(`Too long (at most ${max} characters).`);
      const s = v.normalize("NFC").trim();
      if (s.length === 0) return fail("Cannot be empty.");
      if (s.length > max) return fail(`Too long (at most ${max} characters).`);
      if (FORBIDDEN.test(s)) return fail(PLAIN_RULE);
      return s;
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) return fail("Expected text.");
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) if (k !== "runs" && k !== "align" && !(BLOCK_KEY_SET as Set<string>).has(k)) return fail(`Unknown field: ${k}.`);
    if (o.align !== undefined && !(ALIGNS as readonly unknown[]).includes(o.align)) return fail("Alignment must be left, centre, right or justified.");
    const bp = checkBlockProps(o);
    if ("error" in bp) return fail(bp.error);
    const r = checkRuns(o.runs, max);
    if ("error" in r) return fail(r.error);
    return makeRich(r.runs, o.align as (typeof ALIGNS)[number] | undefined, true, bp.block);
  });
}

// An array of runs on its own (block text, list items), always in run form.
function runsField(name: keyof typeof FIELD_MAX) {
  const max = FIELD_MAX[name];
  return z.unknown().transform((v, ctx) => {
    const r = checkRuns(v, max);
    if ("error" in r) {
      ctx.addIssue({ code: "custom", message: r.error });
      return z.NEVER;
    }
    return r.runs;
  });
}

// ---- building blocks ---------------------------------------------------------------------------------------------------------

const list = <T extends z.ZodType>(item: T, min: number, max: number) => z.array(item).min(min).max(max);
const exactly = <T extends z.ZodType>(item: T, n: number) => z.array(item).length(n, `Exactly ${n} items are supported.`);
const obj = <S extends z.ZodRawShape>(shape: S) => z.object(shape).strict();

const questionKey = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const PROTECTED_QUESTIONS = new Set(Object.values(PROTECTED_FAQ).map((f) => questionKey(f.q)));
const noProtectedQuestions = <T extends { q: string }>(items: T[]) => !items.some((i) => PROTECTED_QUESTIONS.has(questionKey(i.q)));
const PROTECTED_QUESTION_MESSAGE = "A question that repeats a protected one (update frequency, API, ownership) would put a second, conflicting answer next to the protected claim.";

const headingParts = obj({ lead: text("lead"), accent: text("accent") });
const D = DEFAULT_SITE_CONTENT;

const tab = <S extends z.ZodRawShape>(extra: S) => obj({ label: text("label"), ...extra });

// ---- custom sections ---------------------------------------------------------------------------------------------------------

const sectionId = z.string().regex(/^[a-z0-9]{6,24}$/, "Invalid section id.");
const slot = z.enum(SLOT_IDS);

// ---- appearance (see styles.ts): every value is a keyword, a bounded number or a six-digit hex colour -----------------------

const hex = z
  .string()
  .transform((v) => v.toLowerCase())
  .pipe(z.string().regex(HEX, "Use a six-digit colour such as #2457e8."));
const int = (k: keyof typeof LIMITS) => z.number().int().min(LIMITS[k][0], `At least ${LIMITS[k][0]}.`).max(LIMITS[k][1], `At most ${LIMITS[k][1]}.`);
const fontKey = z.enum(FONTS);
const boxAlign = z.enum(BOX_ALIGNS);
const weight = z.enum(WEIGHTS);
const lineHeightField = z
  .number()
  .min(LINE_HEIGHT_RANGE[0])
  .max(LINE_HEIGHT_RANGE[1])
  .transform((n) => Math.round(n * 100) / 100);
const spaceAfterField = z.number().int().min(SPACE_AFTER_RANGE[0]).max(SPACE_AFTER_RANGE[1]);
const onlyTrue = z.literal(true);

const headingStyle = obj({
  font: fontKey.optional(),
  size: int("headingSize").optional(),
  weight: weight.optional(),
  italic: onlyTrue.optional(),
  color: hex.optional(),
  accentColor: hex.optional(),
  leadFont: fontKey.optional(),
  leadWeight: weight.optional(),
  leadItalic: onlyTrue.optional(),
  accentFont: fontKey.optional(),
  accentWeight: weight.optional(),
  accentItalic: onlyTrue.optional(),
  align: boxAlign.optional(),
});
const statCardStyle = obj({
  bg: hex.optional(),
  borderColor: hex.optional(),
  borderWidth: int("borderWidth").optional(),
  radius: int("radius").optional(),
  padX: int("padX").optional(),
  padY: int("padY").optional(),
  align: boxAlign.optional(),
  valueColor: hex.optional(),
  valueSize: int("headingSize").optional(),
  valueWeight: weight.optional(),
  valueFont: fontKey.optional(),
  valueItalic: onlyTrue.optional(),
  labelColor: hex.optional(),
  labelSize: int("buttonSize").optional(),
  labelWeight: weight.optional(),
  labelItalic: onlyTrue.optional(),
});
const imageRef = obj({ mediaId: z.string().regex(MEDIA_ID, "Choose an image."), alt: text("alt"), fit: z.enum(["contain", "cover"]).optional() });
const hrefField = z.string().superRefine((v, ctx) => {
  const bad = validateHref(v);
  if (bad) ctx.addIssue({ code: "custom", message: bad });
});
const buttonSettings = obj({
  href: hrefField.optional(),
  newTab: onlyTrue.optional(),
  font: fontKey.optional(),
  size: int("buttonSize").optional(),
  weight: weight.optional(),
  color: hex.optional(),
  bg: hex.optional(),
  borderColor: hex.optional(),
  borderWidth: int("borderWidth").optional(),
  radius: int("radius").optional(),
  padX: int("padX").optional(),
  padY: int("padY").optional(),
  align: boxAlign.optional(),
});
const sectionStyle = obj({ bg: hex.optional(), padTop: int("sectionPad").optional(), padBottom: int("sectionPad").optional() });
const imageDisplayShape = {
  displayWidth: int("imageSide").optional(),
  displayHeight: int("imageSide").optional(),
  fit: z.enum(["contain", "cover"]).optional(),
  align: boxAlign.optional(),
  radius: int("radius").optional(),
  borderWidth: int("borderWidth").optional(),
  borderColor: hex.optional(),
  wrap: z.enum(["none", "left", "right"]).optional(),
};

const partialRecord = <K extends string, T extends z.ZodType>(keys: readonly K[], value: T) =>
  z.object(Object.fromEntries(keys.map((k) => [k, value.optional()])) as Record<K, z.ZodOptional<T>>).strict();

const isEmpty = (v: unknown) => v === undefined || v === null || (typeof v === "object" && Object.keys(v as object).length === 0);
function prune<T extends object>(o: T | undefined): T | undefined {
  if (!o) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!isEmpty(v)) out[k] = v;
  return Object.keys(out).length ? (out as T) : undefined;
}
const pruneEach = (o: Record<string, object | undefined> | undefined) => prune(Object.fromEntries(Object.entries(o ?? {}).map(([k, x]) => [k, prune(x)])));

// Empty settings are dropped so equal appearance always has equal JSON; a button whose destination is locked in code accepts none.
const stylesField = obj({
  texts: z.record(z.string().max(80).regex(TEXT_KEY, "Not a valid text element."), headingStyle).refine((r) => Object.keys(r).length <= MAX_TEXT_STYLES, `At most ${MAX_TEXT_STYLES} styled texts.`).optional(),
  statCards: statCardStyle.optional(),
  cards: partialRecord(CARD_KEYS, statCardStyle).optional(),
  headings: partialRecord(HEADING_KEYS, headingStyle).optional(),
  buttons: partialRecord(BUTTON_KEYS, buttonSettings).optional(),
  rows: partialRecord(ROW_KEYS, obj({ align: boxAlign.optional() })).optional(),
  sections: partialRecord(BUILTIN_KEYS, sectionStyle).optional(),
})
  .superRefine((v, ctx) => {
    for (const k of BUTTON_KEYS) {
      const b = v.buttons?.[k];
      if (b && "locked" in BUTTONS[k] && (b.href !== undefined || b.newTab !== undefined)) {
        ctx.addIssue({ code: "custom", path: ["buttons", k], message: "This button's destination is fixed in code and cannot be changed." });
      }
    }
  })
  .transform(
    (v): ContentStyles | undefined =>
      prune({ texts: pruneEach(v.texts), statCards: prune(v.statCards), cards: pruneEach(v.cards), headings: pruneEach(v.headings), buttons: pruneEach(v.buttons), rows: pruneEach(v.rows), sections: pruneEach(v.sections) }) as ContentStyles | undefined
  );

const blockProps = {
  lineHeight: lineHeightField.optional(),
  spaceAfter: spaceAfterField.optional(),
  spaceBefore: z.number().int().min(SPACE_BEFORE_RANGE[0]).max(SPACE_BEFORE_RANGE[1]).optional(),
  padX: z.number().int().min(PAD_X_RANGE[0]).max(PAD_X_RANGE[1]).optional(),
  boxWidth: z.number().int().min(BOX_WIDTH_RANGE[0]).max(BOX_WIDTH_RANGE[1]).optional(),
  boxAlign: boxAlign.optional(),
};
const block = z.discriminatedUnion("kind", [
  obj({ kind: z.enum(["p", "h2", "h3"]), align: z.enum(ALIGNS).optional(), ...blockProps, runs: runsField("blockText") }),
  obj({ kind: z.enum(["ul", "ol"]), items: list(runsField("listItem"), 1, 12) }),
  obj({ kind: z.literal("button"), label: text("ctaLabel"), href: hrefField, settings: buttonSettings.omit({ href: true }).optional() }),
  obj({ kind: z.literal("video"), provider: z.enum(VIDEO_PROVIDERS), videoId: z.string().max(20), title: text("videoTitle"), caption: text("caption").optional() }).refine((v) => VIDEO_ID[v.provider].test(v.videoId), { message: "That is not a valid video id for the chosen provider.", path: ["videoId"] }),
  obj({ kind: z.literal("image"), mediaId: z.string().regex(MEDIA_ID, "Choose an image."), alt: text("alt"), caption: text("caption").optional(), width: z.number().int().min(1).max(10000).optional(), height: z.number().int().min(1).max(10000).optional(), ...imageDisplayShape }),
]);

const common = { style: sectionStyle.optional() };
const customSection = z.discriminatedUnion("type", [
  obj({ id: sectionId, slot, type: z.literal("text"), title: text("title").optional(), headingStyle: headingStyle.optional(), blocks: list(block, 1, 12), ...common }),
  obj({ id: sectionId, slot, type: z.literal("image"), mediaId: z.string().regex(MEDIA_ID, "Choose an image."), alt: text("alt"), caption: text("caption").optional(), size: z.enum(["medium", "wide"]), width: z.number().int().min(1).max(10000).optional(), height: z.number().int().min(1).max(10000).optional(), ...imageDisplayShape, ...common }),
  obj({ id: sectionId, slot, type: z.literal("video"), provider: z.enum(VIDEO_PROVIDERS), videoId: z.string().max(20), title: text("videoTitle"), caption: text("caption").optional(), ...common }).refine((v) => VIDEO_ID[v.provider].test(v.videoId), { message: "That is not a valid video id for the chosen provider.", path: ["videoId"] }),
  obj({ id: sectionId, slot, type: z.literal("cta"), heading: text("heading"), headingStyle: headingStyle.optional(), text: richField("text").optional(), buttonLabel: text("ctaLabel"), target: z.enum(CTA_TARGET_IDS), tone: z.enum(["brand", "light"]), button: buttonSettings.optional(), ...common }),
  obj({ id: sectionId, slot, type: z.literal("cards"), heading: text("heading").optional(), headingStyle: headingStyle.optional(), intro: richField("intro").optional(), cards: list(obj({ title: text("title"), text: richField("text") }), 1, 6), ...common }),
  obj({ id: sectionId, slot, type: z.literal("faq"), heading: text("heading"), headingStyle: headingStyle.optional(), items: list(obj({ q: text("q"), a: richField("a") }), 1, 8).refine(noProtectedQuestions, PROTECTED_QUESTION_MESSAGE), ...common }),
]);

export const editableContentSchema = obj({
  hero: obj({ heading: headingParts, intro: richField("intro"), primaryCtaLabel: text("primaryCtaLabel"), secondaryCtaLabel: text("secondaryCtaLabel") }),
  builtFor: obj({ label: text("label"), audiences: list(text("audience"), 3, 8) }),
  ukRegister: obj({
    eyebrow: text("eyebrow"),
    heading: headingParts,
    intro: richField("intro"),
    // Captions of the figure cards; the figures themselves are live data and have no key here.
    labels: obj(Object.fromEntries(STAT_LABEL_KEYS.map((k) => [k, text("statLabel").optional()])) as Record<string, z.ZodType>).optional(),
  }),
  officialSource: obj({ eyebrow: text("eyebrow"), heading: text("heading"), text: richField("text"), ctaLabel: text("ctaLabel") }),
  search: obj({
    eyebrow: text("eyebrow"),
    heading: text("heading"),
    tabs: obj({
      company: tab({ hint: text("hint"), fields: list(text("field"), 1, 8) }),
      filings: tab({ hint: text("hint"), fields: list(text("field"), 1, 8) }),
      directors: tab({ hint: text("hint"), fields: list(text("field"), 1, 8) }),
      sic: tab({ hint: text("hint"), fields: list(text("field"), 1, 8) }),
    }),
  }),
  filters: obj({ eyebrow: text("eyebrow"), heading: text("heading"), text: richField("text") }),
  workflow: obj({
    eyebrow: text("eyebrow"),
    heading: headingParts,
    text: richField("text"),
    tabs: obj({
      lists: tab({ badge: text("badge"), title: text("title"), text: richField("text"), bullets: list(text("bullet"), 1, 6) }),
      reports: tab({ badge: text("badge"), title: text("title"), text: richField("text"), bullets: list(text("bullet"), 1, 6) }),
      crm: tab({ badge: text("badge"), title: text("title"), text: richField("text"), bullets: list(text("bullet"), 1, 6) }),
    }),
    steps: exactly(text("step"), D.workflow.steps.length),
    tryLabel: text("tryLabel"),
  }),
  platform: obj({ eyebrow: text("eyebrow"), heading: text("heading"), text: richField("text"), cards: exactly(obj({ title: text("title"), text: richField("text") }), D.platform.cards.length) }),
  apart: obj({
    eyebrow: text("eyebrow"),
    heading: text("heading"),
    items: exactly(obj({ title: text("title"), text: richField("text") }), D.apart.items.length),
    talk: obj({ title: text("title"), text: richField("text"), ctaLabel: text("ctaLabel") }),
    // Pictures for the three decorative circles (absent: the design's own circles).
    circles: partialRecord(["0", "1", "2"] as const, imageRef).optional(),
  }),
  useCases: obj({
    eyebrow: text("eyebrow"),
    heading: headingParts,
    text: richField("text"),
    items: exactly(obj({ tag: text("tag"), title: text("title"), text: richField("text"), image: imageRef.optional() }), D.useCases.items.length),
  }),
  // Only the editable questions; the update-frequency, API and ownership answers are composed from code (protected-claims.ts).
  faq: obj({
    eyebrow: text("eyebrow"),
    heading: text("heading"),
    items: list(obj({ q: text("q"), a: richField("a") }), 1, 8).refine(noProtectedQuestions, PROTECTED_QUESTION_MESSAGE),
  }),
  finalCta: obj({ heading: text("heading"), text: richField("text"), primaryLabel: text("primaryLabel"), secondaryLabel: text("secondaryLabel") }),
  header: obj({ links: exactly(obj({ label: text("label") }), D.header.links.length) }),
  footer: obj({ tagline: text("tagline"), sectionsTitle: text("sectionsTitle"), links: exactly(obj({ label: text("label") }), D.footer.links.length) }),
  // Sections added by the editor; order in this list is the order within a slot. Absent in older stored content: no sections.
  custom: z
    .array(customSection)
    .max(MAX_CUSTOM_SECTIONS, `At most ${MAX_CUSTOM_SECTIONS} added sections.`)
    .default([])
    .refine((s) => new Set(s.map((x) => x.id)).size === s.length, "Section ids must be unique."),
  // Appearance settings and the explicit section order. Both are absent unless an editor has set them: the page then looks, and
  // is ordered, exactly as the built-in design.
  styles: stylesField.optional(),
  order: z.array(z.string().max(48)).max(BUILTIN_KEYS.length + MAX_CUSTOM_SECTIONS).optional(),
}).superRefine((v, ctx) => {
  if (v.order) {
    const bad = validateOrder(v.order, v.custom.map((c) => c.id));
    if (bad) ctx.addIssue({ code: "custom", path: ["order"], message: bad });
  }
});

export type EditableContent = z.infer<typeof editableContentSchema>;
export type CustomSectionContent = EditableContent["custom"][number];

export interface ContentIssue {
  path: string;
  message: string;
}

export type ContentResult = { ok: true; content: EditableContent } | { ok: false; issues: ContentIssue[] };

// Validates untrusted input (an API body, stored JSON). On success the returned content is the normalised copy.
export function parseEditableContent(input: unknown): ContentResult {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(input) ?? "", "utf8");
  } catch {
    return { ok: false, issues: [{ path: "", message: "Content is not valid JSON." }] };
  }
  if (bytes > MAX_CONTENT_BYTES) return { ok: false, issues: [{ path: "", message: `Content is too large (${bytes} bytes; the limit is ${MAX_CONTENT_BYTES}).` }] };
  const parsed = editableContentSchema.safeParse(input);
  if (parsed.success) {
    // Empty appearance settings were pruned to undefined: leave no key behind (one canonical spelling).
    const content = parsed.data;
    if (content.styles === undefined) delete content.styles;
    if (content.order === undefined) delete content.order;
    return { ok: true, content };
  }
  const issues = parsed.error.issues.slice(0, 25).map((i) => ({ path: i.path.join("."), message: i.code === "unrecognized_keys" ? `Unknown field${i.path.length ? ` at ${i.path.join(".")}` : ""}: ${(i as { keys?: string[] }).keys?.join(", ")}.` : i.message }));
  return { ok: false, issues };
}

// Every uploaded image a content object refers to (for the existence check and the media route).
export function mediaIdsIn(content: EditableContent): string[] {
  const slots = [...Object.values(content.apart.circles ?? {}), ...content.useCases.items.map((i) => i.image)].flatMap((r) => (r ? [r.mediaId] : []));
  return [...new Set([...slots, ...content.custom.flatMap((s) => (s.type === "image" ? [s.mediaId] : s.type === "text" ? s.blocks.flatMap((b) => (b.kind === "image" ? [b.mediaId] : [])) : []))])];
}

export { richPlain };
