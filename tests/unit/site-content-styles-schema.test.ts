import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SITE_CONTENT } from "@/lib/site-content/defaults";
import { applyEditable, mediaIdsIn, parseEditableContent, toEditable, type EditableContent } from "@/lib/site-content/schema";
import { newSection } from "@/lib/site-content/editor-model";
import { contentHash } from "@/lib/site-content/canonical";
import { DEFAULT_ORDER, defaultOrder } from "@/lib/site-content/styles";

const base = (): EditableContent => JSON.parse(JSON.stringify(toEditable(DEFAULT_SITE_CONTENT)));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mut = (fn: (c: any) => void) => {
  const c = base();
  fn(c);
  return c;
};
const ok = (c: unknown) => {
  const r = parseEditableContent(c);
  assert.ok(r.ok, r.ok ? "" : JSON.stringify(r.issues));
  return r.ok ? r.content : base();
};
const bad = (c: unknown, why?: RegExp) => {
  const r = parseEditableContent(c);
  assert.equal(r.ok, false, JSON.stringify(c).slice(0, 200));
  const issues = r.ok ? [] : r.issues;
  if (why) assert.match(issues.map((i) => `${i.path} ${i.message}`).join(" | "), why);
  return issues;
};
const MEDIA = "a".repeat(32);

// ---- rich marks ---------------------------------------------------------------------------------------------------------------------

test("formatted text may carry hex colours, highlights, whole-pixel sizes and a font from the list", () => {
  const out = ok(mut((c) => (c.hero.intro = { runs: [{ text: "a", color: "#2457E8", bg: "#FFF3B0", size: 22, font: "serif" }, { text: "b", color: "brand", size: "lg" }], align: "justify", lineHeight: 1.5, spaceAfter: 16 })));
  assert.deepEqual(out.hero.intro, { runs: [{ text: "a", color: "#2457e8", bg: "#fff3b0", size: 22, font: "serif" }, { text: "b", color: "brand", size: "lg" }], align: "justify", lineHeight: 1.5, spaceAfter: 16 }, "hex is stored lower case; legacy keys still validate");
});

test("a paragraph with only line spacing is still a structured value (it must not collapse to a string and lose it)", () => {
  const out = ok(mut((c) => (c.hero.intro = { runs: [{ text: "Plain words" }], lineHeight: 2 })));
  assert.deepEqual(out.hero.intro, { runs: [{ text: "Plain words" }], lineHeight: 2 });
});

test("colours, sizes, fonts and spacing outside the supported values are refused", () => {
  const intro = (v: unknown) => mut((c) => (c.hero.intro = v));
  bad(intro({ runs: [{ text: "x", color: "#fff" }] }), /six-digit/);
  bad(intro({ runs: [{ text: "x", color: "rgb(0,0,0)" }] }), /six-digit/);
  bad(intro({ runs: [{ text: "x", color: "#000000;background:url(//x)" }] }), /six-digit/);
  bad(intro({ runs: [{ text: "x", bg: "brand" }] }), /six-digit/);
  bad(intro({ runs: [{ text: "x", size: 7 }] }), /between 8 and 120/);
  bad(intro({ runs: [{ text: "x", size: 121 }] }), /between 8 and 120/);
  bad(intro({ runs: [{ text: "x", size: "12px" }] }), /between 8 and 120/);
  bad(intro({ runs: [{ text: "x", size: NaN }] }));
  bad(intro({ runs: [{ text: "x", font: "Arial" }] }), /font/);
  bad(intro({ runs: [{ text: "x", font: "serif; color:red" }] }), /font/);
  bad(intro({ runs: [{ text: "x" }], lineHeight: 0.5 }), /Line height/);
  bad(intro({ runs: [{ text: "x" }], lineHeight: "2" }), /Line height/);
  bad(intro({ runs: [{ text: "x" }], spaceAfter: 97 }), /Space after/);
  bad(intro({ runs: [{ text: "x" }], spaceAfter: 1.5 }), /Space after/);
  bad(intro({ runs: [{ text: "x" }], align: "justified" }), /Alignment/);
  bad(intro({ runs: [{ text: "x" }], style: "color:red" }), /Unknown field/);
});

test("added-section text blocks take line height and spacing too, and justified alignment", () => {
  const c = base();
  c.custom = [{ id: "abcdef123456", slot: "beforeFaq", type: "text", blocks: [{ kind: "p", runs: [{ text: "Hi", color: "#112233" }], align: "justify", lineHeight: 1.75, spaceAfter: 24 }] }];
  const out = ok(c);
  assert.deepEqual(out.custom[0].type === "text" && out.custom[0].blocks[0], { kind: "p", runs: [{ text: "Hi", color: "#112233" }], align: "justify", lineHeight: 1.75, spaceAfter: 24 });
  bad(mut((x) => (x.custom = [{ ...c.custom[0], blocks: [{ kind: "p", runs: [{ text: "Hi" }], lineHeight: 9 }] }])));
});

// ---- appearance settings -------------------------------------------------------------------------------------------------------------

test("a page without settings has no styles key, and settings that are empty are dropped (one canonical spelling)", () => {
  assert.equal("styles" in ok(base()), false);
  const empty = ok(mut((c) => (c.styles = { buttons: { "hero.secondary": {} }, headings: {}, rows: { "hero.buttons": {} } })));
  assert.equal("styles" in empty, false);
  assert.equal(contentHash(empty), contentHash(ok(base())));
});

test("button, heading, row and section settings validate and are stored as given", () => {
  const styles = {
    buttons: { "hero.secondary": { href: "https://example.com/offer", newTab: true, color: "#FFFFFF", bg: "#2457e8", borderColor: "#112233", borderWidth: 2, radius: 24, padX: 40, padY: 20, size: 18, weight: "bold", font: "serif" }, "hero.primary": { bg: "#101010", align: "right" } },
    headings: { "hero.heading": { size: 64, color: "#0B2A6F", accentColor: "#B45309", italic: true, font: "serif", weight: "extrabold", align: "left" } },
    rows: { "hero.buttons": { align: "left" } },
    sections: { faq: { bg: "#F1F5F9", padTop: 40, padBottom: 0 } },
  };
  const out = ok(mut((c) => (c.styles = styles)));
  assert.equal(out.styles?.buttons?.["hero.secondary"]?.color, "#ffffff", "hex normalised to lower case");
  assert.equal(out.styles?.headings?.["hero.heading"]?.accentColor, "#b45309");
  assert.equal(out.styles?.sections?.faq?.bg, "#f1f5f9");
  assert.equal(out.styles?.rows?.["hero.buttons"]?.align, "left");
});

test("settings outside the supported properties and ranges are refused", () => {
  const st = (v: unknown) => mut((c) => (c.styles = v));
  bad(st({ buttons: { "hero.secondary": { bg: "red" } } }), /six-digit/);
  bad(st({ buttons: { "hero.secondary": { bg: "#2457e8; position:fixed" } } }), /six-digit/);
  bad(st({ buttons: { "hero.secondary": { css: "x" } } }), /Unknown field/);
  bad(st({ buttons: { "hero.secondary": { radius: 49 } } }), /At most 48/);
  bad(st({ buttons: { "hero.secondary": { padX: 7 } } }), /At least 8/);
  bad(st({ buttons: { "hero.secondary": { padX: 12.5 } } }));
  bad(st({ buttons: { "hero.secondary": { size: 9 } } }), /At least 10/);
  bad(st({ buttons: { "hero.secondary": { font: "Papyrus" } } }));
  bad(st({ buttons: { "hero.secondary": { weight: "black" } } }));
  bad(st({ buttons: { "hero.secondary": { align: "justify" } } }));
  bad(st({ buttons: { "not.a.button": { bg: "#000000" } } }), /Unknown field/);
  bad(st({ headings: { "hero.heading": { size: 141 } } }), /At most 140/);
  bad(st({ headings: { "nope.heading": { size: 20 } } }), /Unknown field/);
  bad(st({ sections: { hero2: { bg: "#000000" } } }), /Unknown field/);
  bad(st({ sections: { faq: { padTop: 241 } } }), /At most 240/);
  bad(st({ rows: { "hero.buttons": { align: "middle" } } }));
  bad(st({ extra: {} }), /Unknown field/);
  bad(st("color:red"));
  bad(st([]));
});

test("button destinations are checked: https, mailto and the site's own pages only", () => {
  const dest = (href: unknown) => mut((c) => (c.styles = { buttons: { "hero.secondary": { href } } }));
  for (const good of ["/", "/login", "#uk-data", "#faq", "https://example.com/a?b=1#c", "mailto:sales@example.com"]) ok(dest(good));
  for (const badHref of ["javascript:alert(1)", "http://example.com", "//example.com", "data:text/html;base64,AAAA", "https://user:pw@example.com/", "https://exa mple.com", "https://localhost/", "/some/other/page", "#nope", "ftp://example.com", "", "https://" + "a".repeat(300) + ".com", 5, null]) {
    bad(dest(badHref));
  }
});

test("sign-in buttons keep their destination in code: a stored destination or new-tab flag is refused with a clear reason", () => {
  for (const key of ["hero.primary", "source.cta", "apart.cta", "workflow.try", "final.primary"]) {
    bad(mut((c) => (c.styles = { buttons: { [key]: { href: "https://example.com" } } })), /fixed in code/);
    bad(mut((c) => (c.styles = { buttons: { [key]: { newTab: true } } })), /fixed in code/);
    ok(mut((c) => (c.styles = { buttons: { [key]: { bg: "#112233", color: "#ffffff", radius: 4 } } })));
  }
  ok(mut((c) => (c.styles = { buttons: { "final.secondary": { href: "https://example.com", newTab: true } } })));
});

test("an added call-to-action button may have its own destination and look; added sections take a style and heading style", () => {
  const c = base();
  const cta = newSection({ type: "cta" }, "beforeFaq");
  c.custom = [{ ...cta, button: { href: "https://example.com/go", newTab: true, bg: "#112233" }, headingStyle: { size: 40, color: "#ffffff" }, style: { bg: "#0b2a6f", padTop: 20 } } as never];
  const out = ok(c);
  assert.equal(out.custom[0].type === "cta" && out.custom[0].button?.href, "https://example.com/go");
  c.custom = [{ ...cta, button: { href: "javascript:alert(1)" } } as never];
  bad(c);
});

// ---- images --------------------------------------------------------------------------------------------------------------------------

test("an image section and an image block take size, fit, alignment, wrapping, corners and border", () => {
  const c = base();
  c.custom = [
    { id: "imgsection001", slot: "afterHero", type: "image", mediaId: MEDIA, alt: "A chart", size: "medium", width: 800, height: 600, displayWidth: 320, displayHeight: 240, fit: "contain", align: "right", radius: 12, borderWidth: 2, borderColor: "#112233" } as never,
    { id: "textsection01", slot: "beforeFaq", type: "text", blocks: [{ kind: "image", mediaId: "b".repeat(32), alt: "Team photo", caption: "Us", width: 100, height: 50, displayWidth: 200, wrap: "left", align: "left" }, { kind: "p", runs: [{ text: "Text beside it" }] }] } as never,
  ];
  const out = ok(c);
  assert.equal(out.custom[0].type === "image" && out.custom[0].fit, "contain");
  assert.deepEqual(mediaIdsIn(out).sort(), [MEDIA, "b".repeat(32)], "images inside text blocks count as used media (protected from deletion, served when published)");
});

test("image display values are bounded and the media id is validated", () => {
  const img = (extra: Record<string, unknown>) => mut((c) => (c.custom = [{ id: "imgsection001", slot: "afterHero", type: "image", mediaId: MEDIA, alt: "x", size: "medium", ...extra }]));
  ok(img({ displayWidth: 24 }));
  bad(img({ displayWidth: 23 }), /At least 24/);
  bad(img({ displayWidth: 1601 }), /At most 1600/);
  bad(img({ displayHeight: 24.5 }));
  bad(img({ fit: "stretch" }));
  bad(img({ wrap: "center" }));
  bad(img({ align: "justify" }));
  bad(img({ radius: 49 }));
  bad(img({ borderColor: "red" }), /six-digit/);
  bad(img({ mediaId: "../../etc/passwd" }), /Choose an image/);
  bad(img({ mediaId: "A".repeat(32) }), /Choose an image/);
  const blockImg = (extra: Record<string, unknown>) => mut((c) => (c.custom = [{ id: "textsection01", slot: "beforeFaq", type: "text", blocks: [{ kind: "image", mediaId: MEDIA, alt: "x", ...extra }] }]));
  ok(blockImg({ wrap: "right" }));
  bad(blockImg({ alt: "" }), /empty/i);
  bad(blockImg({ mediaId: "nope" }), /Choose an image/);
  bad(blockImg({ displayWidth: 5000 }));
  bad(blockImg({ html: "<img>" }), /Unknown field/);
});

// ---- order ---------------------------------------------------------------------------------------------------------------------------

test("a page without an explicit order stores none; a valid order round-trips; every defect is refused", () => {
  assert.equal("order" in ok(base()), false);
  const moved = [...DEFAULT_ORDER] as string[];
  const [x] = moved.splice(1, 1);
  moved.splice(3, 0, x);
  assert.deepEqual(ok(mut((c) => (c.order = moved))).order, moved);
  const orderBad = (o: unknown, why: RegExp) => bad(mut((c) => (c.order = o)), why);
  orderBad(moved.slice(1), /exactly once/);
  orderBad([...moved, "faq"], /exactly once|twice/);
  orderBad([moved[1], moved[0], ...moved.slice(2)], /hero/);
  orderBad([...moved.slice(0, -2), "finalCta", moved[moved.length - 2]], /final call to action/);
  orderBad(moved.map((k) => (k === "faq" ? "evil" : k)), /Unknown/);
  orderBad(moved.map((k) => (k === "faq" ? "custom:abcdef123456" : k)), /Unknown/);
  orderBad("hero,faq", /array|Invalid/i);
  orderBad(moved.map((k) => (k === "faq" ? 5 : k)), /./);
  orderBad(Array.from({ length: 80 }, () => "faq"), /./);
});

test("the order must name exactly the added sections the page has", () => {
  const c = base();
  c.custom = [newSection({ type: "text" }, "beforeFaq")];
  const id = c.custom[0].id;
  const order = defaultOrder(c.custom);
  assert.deepEqual(ok({ ...c, order }).order, order);
  bad({ ...c, order: order.filter((k) => k !== `custom:${id}`) }, /exactly once/);
  bad({ ...c, order: DEFAULT_ORDER }, /exactly once/);
  bad({ ...c, order: order.map((k) => (k === `custom:${id}` ? "custom:otherid123456" : k)) }, /Unknown/);
});

test("appearance and order survive editable <-> site content conversion", () => {
  const c = base();
  c.styles = { headings: { "hero.heading": { size: 60 } } };
  c.order = ["hero", "register", "builtFor", ...DEFAULT_ORDER.slice(3)];
  const site = applyEditable(DEFAULT_SITE_CONTENT, c);
  assert.deepEqual(site.styles, c.styles);
  assert.deepEqual(site.order, c.order);
  assert.deepEqual(toEditable(site).order, c.order);
  assert.deepEqual(toEditable(site).styles, c.styles);
  const plain = applyEditable(DEFAULT_SITE_CONTENT, base());
  assert.equal("styles" in plain, false);
  assert.equal("order" in plain, false);
});

test("sign-in destinations cannot be reached through a rich link either: links stay on the allowlist", () => {
  bad(mut((c) => (c.hero.intro = { runs: [{ text: "x", href: "javascript:alert(1)" }] })));
  bad(mut((c) => (c.hero.intro = { runs: [{ text: "x", href: "/admin" }] })));
  ok(mut((c) => (c.hero.intro = { runs: [{ text: "x", href: "/" }] })));
});
