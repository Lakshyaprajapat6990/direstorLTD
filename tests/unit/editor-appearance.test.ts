import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SITE_CONTENT } from "@/lib/site-content/defaults";
import { parseEditableContent, toEditable, type EditableContent } from "@/lib/site-content/schema";
import {
  addCustomSection,
  currentOrder,
  describePath,
  finalIndexForGap,
  moveSection,
  moveSectionBy,
  newImageBlock,
  newSection,
  outline,
  patchBlock,
  patchCustom,
  patchCustomField,
  patchStyle,
  removeCustomSection,
  resetOrder,
  resetStyle,
  sectionLabel,
  setSectionSlot,
  styleOf,
} from "@/lib/site-content/editor-model";
import { DEFAULT_ORDER, customKey, validateOrder, type OrderKey } from "@/lib/site-content/styles";

const base = (): EditableContent => JSON.parse(JSON.stringify(toEditable(DEFAULT_SITE_CONTENT)));
const valid = (c: EditableContent) => {
  const r = parseEditableContent(c);
  assert.ok(r.ok, r.ok ? "" : JSON.stringify(r.issues));
};

// ---- settings --------------------------------------------------------------------------------------------------------------------------

test("patchStyle sets, changes and clears single settings, and leaves no empty containers behind", () => {
  const c0 = base();
  const c1 = patchStyle(c0, "buttons", "hero.secondary", { bg: "#112233", radius: 8 });
  assert.deepEqual(c1.styles, { buttons: { "hero.secondary": { bg: "#112233", radius: 8 } } });
  assert.equal("styles" in c0, false, "the original is not touched");
  const c2 = patchStyle(c1, "buttons", "hero.secondary", { radius: undefined });
  assert.deepEqual(c2.styles, { buttons: { "hero.secondary": { bg: "#112233" } } });
  const c3 = patchStyle(c2, "buttons", "hero.secondary", { bg: undefined });
  assert.equal("styles" in c3, false, "back to default appearance: no styles key at all");
  assert.deepEqual(styleOf(c1, "buttons", "hero.secondary"), { bg: "#112233", radius: 8 });
  assert.deepEqual(styleOf(c1, "buttons", "final.secondary"), {});
  valid(c1);
});

test("resetStyle clears everything stored for one element and nothing else", () => {
  let c = patchStyle(base(), "headings", "hero.heading", { size: 60, color: "#112233" });
  c = patchStyle(c, "headings", "faq.heading", { size: 30 });
  const r = resetStyle(c, "headings", "hero.heading");
  assert.deepEqual(r.styles, { headings: { "faq.heading": { size: 30 } } });
});

test("added-section fields are patched in place; undefined removes them", () => {
  const c = base();
  c.custom = [newSection({ type: "cta" }, "beforeFaq")];
  const a = patchCustomField(c, 0, "button", { bg: "#123456", newTab: true });
  assert.deepEqual((a.custom[0] as { button?: unknown }).button, { bg: "#123456", newTab: true });
  const b = patchCustomField(a, 0, "button", { bg: undefined, newTab: undefined });
  assert.equal("button" in b.custom[0], false);
  assert.equal(patchCustom(c, 0, { target: "faq" }).custom[0].type === "cta" && (patchCustom(c, 0, { target: "faq" }).custom[0] as { target: string }).target, "faq");
  valid(a);
});

test("image blocks are created valid and patched by block index", () => {
  const c = base();
  const t = newSection({ type: "text" }, "beforeFaq");
  if (t.type !== "text") throw new Error("text");
  t.blocks = [...t.blocks, newImageBlock({ mediaId: "d".repeat(32), alt: "A photo", width: 640, height: 480 })];
  c.custom = [t];
  valid(c);
  const p = patchBlock(c, 0, 1, { displayWidth: 200, wrap: "right" });
  assert.deepEqual((p.custom[0] as { blocks: unknown[] }).blocks[1], { kind: "image", mediaId: "d".repeat(32), alt: "A photo", width: 640, height: 480, displayWidth: 200, wrap: "right" });
  valid(p);
  assert.deepEqual((p.custom[0] as { blocks: unknown[] }).blocks[0], (c.custom[0] as { blocks: unknown[] }).blocks[0], "other blocks untouched");
});

// ---- order -----------------------------------------------------------------------------------------------------------------------------

test("moving a section stores an explicit, valid order; moving back to the default stores none", () => {
  const c0 = base();
  assert.deepEqual(currentOrder(c0), [...DEFAULT_ORDER]);
  const m = moveSection(c0, "builtFor", 3);
  assert.equal(m.error, null);
  assert.deepEqual(m.content.order?.slice(0, 4), ["hero", "register", "source", "builtFor"]);
  assert.equal(validateOrder(m.content.order ?? [], []), null);
  valid(m.content);
  const back = moveSection(m.content, "builtFor", 1);
  assert.equal(back.error, null);
  assert.equal("order" in back.content, false, "an order equal to the default is not stored");
  assert.equal("order" in c0, false, "the input is not mutated");
});

test("the hero and the call to action cannot be moved, and nothing can pass them", () => {
  const c = base();
  for (const [key, to] of [["hero", 3], ["finalCta", 3], ["faq", 0], ["faq", DEFAULT_ORDER.length - 1]] as const) {
    const r = moveSection(c, key, to);
    assert.ok(r.error, `${key}→${to}`);
    assert.equal(r.content, c);
  }
  assert.ok(moveSectionBy(c, "builtFor", -1).error, "above the hero");
  assert.ok(moveSectionBy(c, "faq", 1).error, "below the final call to action");
  assert.equal(moveSectionBy(c, "faq", -1).error, null);
});

test("up and down move a section by exactly one place in the whole page order", () => {
  let c = base();
  c = moveSectionBy(c, "faq", -1).content;
  let o = currentOrder(c);
  assert.equal(o.indexOf("faq"), DEFAULT_ORDER.indexOf("faq") - 1);
  assert.equal(o.indexOf("useCases"), DEFAULT_ORDER.indexOf("useCases") + 1);
  c = moveSectionBy(c, "faq", 1).content;
  o = currentOrder(c);
  assert.deepEqual(o, [...DEFAULT_ORDER]);
  assert.equal("order" in c, false);
});

test("drop gaps convert to final positions the way a list drag expects", () => {
  // rows 0..4, dragging row 1: dropping in the gap before row 3 (gap 3) lands it at index 2; before row 0 (gap 0) at 0.
  assert.equal(finalIndexForGap(1, 3), 2);
  assert.equal(finalIndexForGap(1, 0), 0);
  assert.equal(finalIndexForGap(3, 1), 1);
  assert.equal(finalIndexForGap(3, 5), 4);
  assert.equal(finalIndexForGap(2, 2), 2);
});

test("reset puts every section back, added ones at their original slot", () => {
  const c = base();
  c.custom = [newSection({ type: "text" }, "afterHero")];
  const key = customKey(c.custom[0].id);
  const moved = moveSection(c, key, currentOrder(c).indexOf("faq")).content;
  assert.ok(moved.order);
  const r = resetOrder(moved);
  assert.equal("order" in r, false);
  assert.equal(currentOrder(r).indexOf(key), currentOrder(r).indexOf("builtFor") + 1);
});

test("adding, duplicating, removing and re-slotting an added section keep an explicit order valid", () => {
  let c = base();
  c.custom = [newSection({ type: "text" }, "afterHero")];
  c = moveSection(c, "builtFor", 3).content; // an explicit order exists now
  const ids = () => c.custom.map((s) => s.id);
  // add
  const added = newSection({ type: "cta" }, "beforeFaq");
  c = addCustomSection(c, added, c.custom.length);
  assert.equal(validateOrder(c.order ?? [], ids()), null);
  assert.equal(currentOrder(c)[currentOrder(c).indexOf("useCases") + 1], customKey(added.id), "lands after its slot's anchor");
  // duplicate: right after the original
  const copy = { ...JSON.parse(JSON.stringify(added)), id: "copyid123456" };
  c = addCustomSection(c, copy, c.custom.length, customKey(added.id));
  assert.equal(currentOrder(c)[currentOrder(c).indexOf(customKey(added.id)) + 1], "custom:copyid123456");
  assert.equal(validateOrder(c.order ?? [], ids()), null);
  // re-slot
  c = setSectionSlot(c, c.custom.findIndex((s) => s.id === added.id), "afterFaq");
  assert.equal(currentOrder(c)[currentOrder(c).indexOf("faq") + 1], customKey(added.id));
  assert.equal(validateOrder(c.order ?? [], ids()), null);
  valid(c);
  // remove
  c = removeCustomSection(c, c.custom.findIndex((s) => s.id === "copyid123456"));
  assert.equal(validateOrder(c.order ?? [], ids()), null);
  assert.ok(!currentOrder(c).includes("custom:copyid123456"));
  valid(c);
});

test("without an explicit order, adding and removing change nothing but the list", () => {
  let c = base();
  c = addCustomSection(c, newSection({ type: "faq" }, "afterFaq"), 0);
  assert.equal("order" in c, false);
  c = removeCustomSection(c, 0);
  assert.equal("order" in c, false);
  assert.deepEqual(c.custom, []);
});

test("section rows have readable names", () => {
  const c = base();
  const t = newSection({ type: "text" }, "beforeFaq");
  c.custom = [t];
  assert.equal(sectionLabel(c, "builtFor"), "“Built for” strip");
  assert.match(sectionLabel(c, customKey(t.id) as OrderKey), /^Heading and text: New section heading/);
});

// ---- what a click means ----------------------------------------------------------------------------------------------------------------

test("clicking a section background, a button label, a heading or an added button opens the matching panel", () => {
  const c = base();
  c.custom = [newSection({ type: "cta" }, "beforeFaq"), newSection({ type: "text" }, "afterHero"), newSection({ type: "video", provider: "youtube", videoId: "dQw4w9WgXcQ" }, "afterFaq")];
  assert.deepEqual(describePath(c, "section:hero"), { kind: "builtinSection", key: "hero" });
  assert.deepEqual(describePath(c, "section:faq"), { kind: "builtinSection", key: "faq" });
  assert.equal(describePath(c, "section:nope").kind, "none");
  assert.deepEqual(describePath(c, "hero.secondaryCtaLabel"), { kind: "button", button: "hero.secondary" });
  assert.deepEqual(describePath(c, "finalCta.primaryLabel"), { kind: "button", button: "final.primary" });
  assert.deepEqual(describePath(c, "workflow.tryLabel"), { kind: "button", button: "workflow.try" });
  assert.deepEqual(describePath(c, "custom.0.buttonLabel"), { kind: "customButton", section: 0 });
  const h = describePath(c, "faq.heading");
  assert.ok(h.kind === "plain" && h.heading && "builtin" in h.heading && h.heading.builtin === "faq.heading");
  const th = describePath(c, "custom.1.title");
  assert.ok(th.kind === "plain" && th.heading && "custom" in th.heading && th.heading.custom === 1);
  const vt = describePath(c, "custom.2.title");
  assert.ok(vt.kind === "plain" && !vt.heading, "a video's title is not a heading");
  const nh = describePath(c, "search.eyebrow");
  assert.ok(nh.kind === "plain" && !nh.heading);
});

test("the text outline lists text only: appearance settings and the order are not text", () => {
  const c = patchStyle(base(), "buttons", "hero.secondary", { bg: "#112233" });
  c.order = [...DEFAULT_ORDER];
  const groups = outline(c).map((g) => g.section);
  assert.ok(groups.length > 5);
  assert.ok(!groups.some((g) => /styles|order/i.test(g)));
  assert.ok(outline(c).flatMap((g) => g.items).every((i) => !/^(styles|order)\./.test(i.path)));
});
