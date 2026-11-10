import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SITE_CONTENT } from "@/lib/site-content/defaults";
import { getIn, parsePath } from "@/lib/site-content/editor-model";
import { toEditable } from "@/lib/site-content/schema";
import {
  BUILTIN_KEYS,
  BUILTIN_SECTIONS,
  BUTTONS,
  BUTTON_KEYS,
  DEFAULT_ORDER,
  HEADINGS,
  HEADING_KEYS,
  LIMITS,
  buttonCss,
  buttonDestination,
  buttonForLabelPath,
  buttonStyleFor,
  customKey,
  defaultOrder,
  fluidFontSize,
  hasImageDisplay,
  headingCss,
  imageCss,
  lockReason,
  moveInOrder,
  resolveOrder,
  rowStyle,
  sectionCss,
  slotAnchor,
  stripOverridden,
  validateOrder,
  type OrderKey,
} from "@/lib/site-content/styles";
import { SLOTS } from "@/lib/site-content/sections";

const e = toEditable(DEFAULT_SITE_CONTENT);

// ---- the registries describe what really exists --------------------------------------------------------------------------------

test("every button points at a real label in the content, and every heading at a real heading", () => {
  for (const k of BUTTON_KEYS) {
    assert.equal(typeof getIn(e, parsePath(BUTTONS[k].labelPath)), "string", k);
    assert.equal(buttonForLabelPath(BUTTONS[k].labelPath), k);
  }
  for (const k of HEADING_KEYS) {
    const v = getIn(e, parsePath(k));
    assert.ok(typeof v === "string" || (typeof v === "object" && v !== null && "lead" in v), k);
    assert.equal(typeof v === "object", HEADINGS[k].parts, `${k}: two-part flag matches the content`);
  }
});

test("every sign-in button has a locked destination; only the in-page buttons can be redirected", () => {
  const editable = BUTTON_KEYS.filter((k) => !("locked" in BUTTONS[k]));
  assert.deepEqual(editable.sort(), ["final.secondary", "hero.secondary"]);
  for (const k of BUTTON_KEYS) {
    if ("locked" in BUTTONS[k]) {
      assert.equal(BUTTONS[k].defaultHref, "/login");
      assert.match(BUTTONS[k].locked, /fixed in code/);
    }
  }
});

test("a locked button ignores any destination that is passed in", () => {
  const d = buttonDestination("hero.primary", { href: "https://evil.example", newTab: true });
  assert.equal(d.href, "/login");
  assert.equal(d.newTab, false);
  assert.ok(d.locked);
  const free = buttonDestination("hero.secondary", { href: "https://example.com/x", newTab: true });
  assert.deepEqual(free, { href: "https://example.com/x", locked: null, external: true, newTab: true });
  assert.equal(buttonDestination("hero.secondary").href, "#uk-data");
});

// ---- order -----------------------------------------------------------------------------------------------------------------------

test("the default order lists every built-in section once, hero first and the call to action last", () => {
  assert.deepEqual([...DEFAULT_ORDER], BUILTIN_SECTIONS.map((s) => s.key));
  assert.equal(new Set(DEFAULT_ORDER).size, DEFAULT_ORDER.length);
  assert.equal(DEFAULT_ORDER[0], "hero");
  assert.equal(DEFAULT_ORDER[DEFAULT_ORDER.length - 1], "finalCta");
  assert.deepEqual([...DEFAULT_ORDER], ["hero", "builtFor", "register", "source", "structure", "search", "filters", "workflow", "platform", "apart", "api", "useCases", "faq", "finalCta"]);
});

test("added sections sit after the built-in section their slot is anchored to (the page's original placement)", () => {
  const custom = SLOTS.map((s, i) => ({ id: `id${i}aaaaaaaa`, slot: s.id }));
  const o = defaultOrder(custom);
  for (const c of custom) {
    const i = o.indexOf(customKey(c.id));
    assert.equal(o[i - 1], slotAnchor(c.slot), c.slot);
  }
  assert.equal(o.length, BUILTIN_KEYS.length + custom.length);
  assert.equal(validateOrder(o, custom.map((c) => c.id)), null);
  const two = defaultOrder([{ id: "first1111111", slot: "beforeFaq" }, { id: "second222222", slot: "beforeFaq" }]);
  assert.deepEqual(two.slice(two.indexOf("useCases"), two.indexOf("useCases") + 3), ["useCases", "custom:first1111111", "custom:second222222"], "several in one slot keep their list order");
});

test("validateOrder accepts only a complete order with hero first and the call to action last", () => {
  const ids = ["abcdef123456"];
  const good = defaultOrder([{ id: ids[0], slot: "afterFaq" }]);
  assert.equal(validateOrder(good, ids), null);
  const swap = (a: number, b: number) => {
    const o = [...good];
    [o[a], o[b]] = [o[b], o[a]];
    return o;
  };
  assert.equal(validateOrder(swap(2, 3), ids), null, "any two middle sections may swap");
  assert.match(validateOrder(swap(0, 1), ids) ?? "", /hero/);
  assert.match(validateOrder(swap(good.length - 1, good.length - 2), ids) ?? "", /call to action/);
  assert.match(validateOrder(good.slice(0, -1), ids) ?? "", /exactly once/);
  assert.match(validateOrder([...good, "register"], ids) ?? "", /exactly once/);
  assert.match(validateOrder(good.map((k) => (k === "faq" ? "nope" : k)), ids) ?? "", /Unknown/);
  assert.match(validateOrder(good.map((k) => (k === "faq" ? "register" : k)), ids) ?? "", /twice/);
  assert.match(validateOrder(good, []) ?? "", /exactly once|Unknown/, "an order naming a section that does not exist");
  assert.match(validateOrder(good.map((k) => (k.startsWith("custom:") ? "custom:zzzzzz999999" : k)), ids) ?? "", /Unknown/);
});

test("resolveOrder uses a valid stored order and falls back to the default for anything else", () => {
  const custom = [{ id: "abcdef123456", slot: "afterHero" as const }];
  const stored = defaultOrder(custom).filter((k) => k !== "register");
  assert.deepEqual(resolveOrder(undefined, custom), defaultOrder(custom));
  assert.deepEqual(resolveOrder(stored, custom), defaultOrder(custom), "an invalid stored order is ignored, never rendered");
  const moved = [...defaultOrder(custom)];
  const [x] = moved.splice(2, 1);
  moved.splice(5, 0, x);
  assert.deepEqual(resolveOrder(moved, custom), moved);
});

test("moveInOrder moves a section, and refuses to disturb or pass the fixed ends", () => {
  const o = defaultOrder([]) as OrderKey[];
  const r = moveInOrder(o, "builtFor", 3);
  assert.equal(r.error, null);
  assert.deepEqual(r.order.slice(0, 4), ["hero", "register", "source", "builtFor"], "ends up below the UK register block");
  assert.ok(moveInOrder(o, "hero", 3).error);
  assert.ok(moveInOrder(o, "finalCta", 3).error);
  assert.match(moveInOrder(o, "faq", 0).error ?? "", /above the hero/);
  assert.match(moveInOrder(o, "faq", o.length - 1).error ?? "", /below the final/);
  assert.equal(moveInOrder(o, "faq", o.indexOf("faq")).error, null);
  assert.deepEqual(moveInOrder(o, "faq", o.indexOf("faq")).order, o);
  assert.ok(moveInOrder(o, "custom:nothere", 2).error);
  assert.deepEqual(o, defaultOrder([]), "the input is never mutated");
});

test("only the hero and the closing call to action are locked, and they say why", () => {
  assert.deepEqual(BUILTIN_KEYS.filter((k) => lockReason(k)), ["hero", "finalCta"]);
  assert.match(lockReason("hero") ?? "", /first/);
  assert.match(lockReason("finalCta") ?? "", /last/);
  assert.equal(lockReason("custom:abc"), null);
});

// ---- css -------------------------------------------------------------------------------------------------------------------------

test("no settings produce no style at all (so the page keeps its original markup)", () => {
  assert.equal(buttonCss(undefined), undefined);
  assert.equal(buttonCss({}), undefined);
  assert.equal(headingCss({}), undefined);
  assert.equal(sectionCss({}), undefined);
  assert.equal(rowStyle(undefined), undefined);
  assert.equal(buttonStyleFor("hero.primary", undefined), undefined);
  assert.equal(hasImageDisplay({}), false);
  assert.equal(hasImageDisplay({ radius: 0 }), true, "a corner radius of 0 is a real setting");
});

test("button settings become exactly the css properties they name, with the border drawn only when asked", () => {
  assert.deepEqual(buttonCss({ color: "#ffffff", bg: "#2457e8", radius: 12, padX: 40, padY: 18, size: 18, weight: "bold", font: "serif" }), {
    fontFamily: "Georgia, 'Times New Roman', Times, serif",
    fontSize: "1.125rem",
    fontWeight: 700,
    color: "#ffffff",
    backgroundColor: "#2457e8",
    borderRadius: "12px",
    paddingTop: "18px",
    paddingBottom: "18px",
    paddingLeft: "40px",
    paddingRight: "40px",
  });
  assert.deepEqual(buttonCss({ borderColor: "#112233", borderWidth: 3 }), { borderStyle: "solid", borderColor: "#112233", borderWidth: "3px" });
  const solo = buttonStyleFor("source.cta", { align: "right" });
  assert.equal(solo?.marginLeft, "auto");
  assert.equal(solo?.marginRight, 0);
  assert.equal(buttonStyleFor("hero.primary", { align: "right" }), undefined, "buttons in a row are aligned through their row");
  assert.deepEqual(rowStyle("right"), { justifyContent: "flex-end", alignItems: "flex-end" });
});

test("a section background uses the shorthand, which replaces gradients as well as colours", () => {
  assert.deepEqual(sectionCss({ bg: "#101010", padTop: 12, padBottom: 0 }), { background: "#101010", paddingTop: "12px", paddingBottom: "0px" });
});

test("heading sizes shrink with the screen, small sizes stay exact", () => {
  assert.equal(fluidFontSize(24), "1.5rem");
  assert.match(fluidFontSize(96), /^clamp\(3rem, [\d.]+vw, 6rem\)$/);
  assert.equal(headingCss({ size: 24, italic: true, weight: "extrabold", color: "#123456", align: "right" })?.fontWeight, 800);
});

test("every range in LIMITS is sane", () => {
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) assert.ok(Number.isInteger(lo) && Number.isInteger(hi) && lo <= hi, k);
});

test("image display: width is a ceiling, both sides keep the proportion, wrapping floats only from the sm breakpoint", () => {
  const a = imageCss({ displayWidth: 300 });
  assert.deepEqual(a.wrap, { display: "block", width: "100%", maxWidth: "300px", marginLeft: "auto", marginRight: "auto" });
  assert.equal(a.img.height, "auto");
  const b = imageCss({ displayWidth: 400, displayHeight: 200, fit: "contain", radius: 8, align: "left" });
  assert.equal(b.img.aspectRatio, "400 / 200");
  assert.equal(b.img.objectFit, "contain");
  assert.equal(b.img.borderRadius, "8px");
  assert.equal(b.wrap.marginLeft, 0);
  const c = imageCss({ displayHeight: 100 }, { width: 400, height: 200 });
  assert.equal(c.wrap.maxWidth, "200px", "a height alone turns into a width ceiling that keeps the picture's proportions");
  const w = imageCss({ displayWidth: 200, wrap: "left" });
  assert.match(w.floatClass, /^sm:float-left /);
  assert.equal(w.wrap.marginLeft, "auto", "on a phone the image is a centred block");
  assert.equal(imageCss({ wrap: "none" }).floatClass, "");
  assert.deepEqual(imageCss({ borderWidth: 2, borderColor: "#00ff00" }).img, { display: "block", width: "100%", height: "auto", borderStyle: "solid", borderWidth: "2px", borderColor: "#00ff00" });
});

test("important utility classes are dropped only for the property that was overridden", () => {
  const cls = "rounded-md !bg-white px-8 !text-indigo-900 hover:!bg-blue-50";
  const strip = { bg: ["!bg-white", "hover:!bg-blue-50"], color: ["!text-indigo-900"] };
  assert.equal(stripOverridden(cls, undefined, strip), cls);
  assert.equal(stripOverridden(cls, { backgroundColor: "#000000" }, strip), "rounded-md px-8 !text-indigo-900");
  assert.equal(stripOverridden(cls, { color: "#000000" }, strip), "rounded-md !bg-white px-8 hover:!bg-blue-50");
  assert.equal(stripOverridden(cls, { fontSize: "1rem" }, strip), cls);
});
