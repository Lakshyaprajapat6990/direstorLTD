import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SITE_CONTENT } from "@/lib/site-content/defaults";
import { PROTECTED_FAQ } from "@/lib/site-content/protected-claims";
import { MAX_CONTENT_BYTES, applyEditable, mediaIdsIn, parseEditableContent, toEditable, type EditableContent } from "@/lib/site-content/schema";
import { newSection } from "@/lib/site-content/editor-model";
import { contentHash } from "@/lib/site-content/canonical";

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
const bad = (c: unknown) => {
  const r = parseEditableContent(c);
  assert.equal(r.ok, false);
  return r.ok ? [] : r.issues;
};
const MEDIA = "a".repeat(32);

// ---- rich values ---------------------------------------------------------------------------------------------------------------

test("a paragraph may be a plain string or formatted runs; both validate and plain stays a string", () => {
  assert.equal(ok(mut((c) => (c.hero.intro = "Just words."))).hero.intro, "Just words.");
  const out = ok(mut((c) => (c.hero.intro = { runs: [{ text: "Some " }, { text: "bold", b: true }, { text: " words, " }, { text: "linked", href: "/login" }], align: "center" })));
  assert.deepEqual(out.hero.intro, { runs: [{ text: "Some " }, { text: "bold", b: true }, { text: " words, " }, { text: "linked", href: "/login" }], align: "center" });
});

test("formatting that adds nothing collapses to the plain string (one canonical spelling, stable hashes)", () => {
  const a = ok(mut((c) => (c.hero.intro = { runs: [{ text: "Hello " }, { text: "there" }] })));
  assert.equal(a.hero.intro, "Hello there");
  const b = ok(mut((c) => (c.hero.intro = "Hello there")));
  assert.equal(contentHash(a), contentHash(b));
});

test("rich values reject unknown keys, invalid colours, fonts, sizes, spacing and alignment", () => {
  for (const intro of [
    { runs: [{ text: "x", style: "color:red" }] },
    { runs: [{ text: "x", color: "#ff00" }] },
    { runs: [{ text: "x", color: "#ff0000; background:url(x)" }] },
    { runs: [{ text: "x", bg: "red" }] },
    { runs: [{ text: "x", size: 7 }] },
    { runs: [{ text: "x", size: 121 }] },
    { runs: [{ text: "x", size: 12.5 }] },
    { runs: [{ text: "x", font: "Comic Sans MS" }] },
    { runs: [{ text: "x", color: "red" }] },
    { runs: [{ text: "x", size: "huge" }] },
    { runs: [{ text: "x", b: "yes" }] },
    { runs: [{ text: "x" }], align: "full" },
    { runs: [{ text: "x" }], lineHeight: 5 },
    { runs: [{ text: "x" }], spaceAfter: -1 },
    { runs: [{ text: "x" }], html: "<b>x</b>" },
    { runs: "x" },
    { runs: [] },
    { runs: [{ text: "" }] },
    { runs: [{ text: "   " }] },
    { runs: [{ nope: 1 }] },
    { runs: [null] },
    [],
    5,
    null,
  ]) {
    assert.equal(parseEditableContent(mut((c) => (c.hero.intro = intro))).ok, false, JSON.stringify(intro));
  }
});

test("rich text is plain text underneath: markup, scripts and control characters are refused in runs too", () => {
  for (const text of ["<b>x</b>", "a < b", "<script>alert(1)</script>", "line\nbreak", "nul\u0000", "rtl‮override", "zero​width"]) {
    assert.equal(parseEditableContent(mut((c) => (c.hero.intro = { runs: [{ text }] }))).ok, false, JSON.stringify(text));
  }
});

test("links inside text are validated against the same rules as the toolbar", () => {
  for (const href of ["javascript:alert(1)", "data:text/html;base64,AAAA", "http://example.com", "/admin", "//evil.example", "https://", "https://u:p@example.com"]) {
    const issues = bad(mut((c) => (c.hero.intro = { runs: [{ text: "x", href }] })));
    assert.ok(issues.length, href);
  }
  for (const href of ["/login", "#faq", "https://example.com/page", "mailto:team@example.com"]) ok(mut((c) => (c.hero.intro = { runs: [{ text: "x", href }] })));
});

test("the visible length of rich text is limited, not the number of formatting pieces", () => {
  const long = (n: number) => ({ runs: [{ text: "a".repeat(n - 1), b: true }, { text: "b" }] });
  ok(mut((c) => (c.hero.intro = long(400))));
  assert.equal(parseEditableContent(mut((c) => (c.hero.intro = long(401)))).ok, false);
  const many = { runs: Array.from({ length: 61 }, (_, i) => ({ text: "x", b: i % 2 === 0 ? (true as const) : undefined })) };
  assert.equal(parseEditableContent(mut((c) => (c.hero.intro = many))).ok, false, "more than 60 pieces");
});

test("every paragraph field in the built-in content accepts formatting", () => {
  const rich = { runs: [{ text: "x", b: true as const }] };
  const paths: ((c: EditableContent) => void)[] = [
    (c) => (c.hero.intro = rich),
    (c) => (c.ukRegister.intro = rich),
    (c) => (c.officialSource.text = rich),
    (c) => (c.filters.text = rich),
    (c) => (c.workflow.text = rich),
    (c) => (c.workflow.tabs.crm.text = rich),
    (c) => (c.platform.text = rich),
    (c) => (c.platform.cards[3].text = rich),
    (c) => (c.apart.talk.text = rich),
    (c) => (c.apart.items[2].text = rich),
    (c) => (c.useCases.text = rich),
    (c) => (c.useCases.items[1].text = rich),
    (c) => (c.faq.items[0].a = rich),
    (c) => (c.finalCta.text = rich),
  ];
  for (const set of paths) ok(mut(set));
});

test("labels, headings and button text stay plain: formatting there is refused", () => {
  const rich = { runs: [{ text: "x", b: true }] };
  for (const set of [(c: any) => (c.hero.primaryCtaLabel = rich), (c: any) => (c.faq.heading = rich), (c: any) => (c.header.links[0].label = rich), (c: any) => (c.platform.cards[0].title = rich)]) {
    assert.equal(parseEditableContent(mut(set)).ok, false);
  }
});

// ---- added sections ---------------------------------------------------------------------------------------------------------------

const section = (type: string, over: Record<string, unknown> = {}) => {
  const s: Record<string, unknown> =
    type === "text"
      ? { type, title: "Heading", blocks: [{ kind: "p", runs: [{ text: "Words" }] }] }
      : type === "image"
        ? { type, mediaId: MEDIA, alt: "A picture", size: "medium" }
        : type === "video"
          ? { type, provider: "youtube", videoId: "dQw4w9WgXcQ", title: "A video" }
          : type === "cta"
            ? { type, heading: "Go", buttonLabel: "Sign in", target: "login", tone: "brand" }
            : type === "cards"
              ? { type, cards: [{ title: "One", text: "First" }] }
              : { type, heading: "Questions", items: [{ q: "Why?", a: "Because." }] };
  return { id: `sec${type}12345`, slot: "beforeFaq", ...s, ...over };
};
const withSections = (...s: unknown[]) => mut((c) => (c.custom = s));

test("content stored before added sections existed still validates, with no sections", () => {
  const old = base() as unknown as Record<string, unknown>;
  delete old.custom;
  assert.deepEqual(ok(old).custom, []);
});

test("every section type validates in its simplest form", () => {
  for (const t of ["text", "image", "video", "cta", "cards", "faq"]) ok(withSections(section(t)));
  ok(withSections(...["text", "image", "video", "cta", "cards", "faq"].map((t) => section(t))));
});

test("the editor's own starter sections for each type are valid as they are created", () => {
  for (const input of [{ type: "text" }, { type: "cta" }, { type: "cards" }, { type: "faq" }, { type: "image", mediaId: MEDIA, alt: "x", width: 10, height: 10 }, { type: "video", provider: "vimeo", videoId: "123456789" }] as const) {
    const s = newSection(input, "afterHero");
    ok(withSections(s));
    assert.match(s.id, /^[a-z0-9]{6,24}$/);
  }
});

test("sections are strict: unknown fields, unknown types, free-form values and bad ids are refused", () => {
  for (const s of [
    section("text", { css: "color:red" }),
    section("text", { type: "html", html: "<b>x</b>" }),
    section("text", { slot: "header" }),
    section("text", { id: "BAD ID!" }),
    section("text", { id: "abc" }),
    section("cta", { target: "/admin" }),
    section("cta", { target: "https://evil.example" }),
    section("cta", { tone: "red" }),
    section("image", { mediaId: "../../etc/passwd" }),
    section("image", { mediaId: "A".repeat(32) }),
    section("image", { src: "https://evil.example/x.png" }),
    section("image", { size: "full" }),
    section("image", { alt: "" }),
    section("image", { width: 0 }),
    section("video", { provider: "dailymotion" }),
    section("video", { videoId: "short" }),
    section("video", { provider: "vimeo", videoId: "dQw4w9WgXcQ" }),
    section("video", { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
    section("video", { title: "" }),
  ]) {
    assert.equal(parseEditableContent(withSections(s)).ok, false, JSON.stringify(s).slice(0, 90));
  }
});

test("a text section's blocks: kinds, counts, list shapes and text rules", () => {
  const blocks = (b: unknown[]) => withSections(section("text", { blocks: b }));
  ok(blocks([{ kind: "h2", runs: [{ text: "Head" }] }, { kind: "h3", runs: [{ text: "Sub" }], align: "right" }, { kind: "ul", items: [[{ text: "a" }], [{ text: "b", b: true }]] }, { kind: "ol", items: [[{ text: "1" }]] }]));
  for (const b of [[], [{ kind: "iframe", runs: [{ text: "x" }] }], [{ kind: "p", runs: [] }], [{ kind: "p", runs: [{ text: "<b>" }] }], [{ kind: "ul", items: [] }], [{ kind: "ul", items: [[{ text: "" }]] }], [{ kind: "p", html: "x", runs: [{ text: "x" }] }], [{ kind: "ul", runs: [{ text: "x" }] }], Array.from({ length: 13 }, () => ({ kind: "p", runs: [{ text: "x" }] })), [{ kind: "ul", items: Array.from({ length: 13 }, () => [{ text: "x" }]) }]]) {
    assert.equal(parseEditableContent(blocks(b)).ok, false, JSON.stringify(b).slice(0, 80));
  }
});

test("counts: at most 12 sections, 6 cards and 8 questions per section; ids must be unique", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => section("cta", { id: `cta${String(i).padStart(8, "0")}` }));
  ok(withSections(...many(12)));
  assert.equal(parseEditableContent(withSections(...many(13))).ok, false);
  assert.equal(parseEditableContent(withSections(section("cta"), section("cta"))).ok, false, "duplicate ids");
  const cards = (n: number) => withSections(section("cards", { cards: Array.from({ length: n }, (_, i) => ({ title: `T${i}`, text: "x" })) }));
  ok(cards(6));
  assert.equal(parseEditableContent(cards(7)).ok, false);
  assert.equal(parseEditableContent(cards(0)).ok, false);
  const faqs = (n: number) => withSections(section("faq", { items: Array.from({ length: n }, (_, i) => ({ q: `Q${i}?`, a: "x" })) }));
  ok(faqs(8));
  assert.equal(parseEditableContent(faqs(9)).ok, false);
});

test("an added FAQ may not repeat a protected question either", () => {
  for (const q of [PROTECTED_FAQ.ownership.q, PROTECTED_FAQ.updated.q]) {
    const issues = bad(withSections(section("faq", { items: [{ q, a: "Yes." }] })));
    assert.ok(issues.some((i) => /protected/.test(i.message)), q);
  }
});

test("optional text (title, caption, intro, heading, button text) can be absent but never empty", () => {
  ok(withSections(section("text", { title: undefined })));
  ok(withSections(section("image", { caption: undefined })));
  ok(withSections(section("cards", { heading: undefined, intro: undefined })));
  ok(withSections(section("cta", { text: undefined })));
  for (const s of [section("text", { title: "" }), section("image", { caption: "   " }), section("cards", { heading: "" }), section("cta", { text: "" })]) assert.equal(parseEditableContent(withSections(s)).ok, false);
});

test("added sections carry through to the rendered content, and not when there are none", () => {
  const s = section("cta");
  const c = ok(withSections(s));
  assert.equal(applyEditable(DEFAULT_SITE_CONTENT, c).custom?.length, 1);
  const none = applyEditable(DEFAULT_SITE_CONTENT, ok(base()));
  assert.equal("custom" in none, false);
  assert.deepEqual(none, DEFAULT_SITE_CONTENT, "no sections: exactly the built-in content");
});

test("the images a content object refers to are listed once each (for the existence check)", () => {
  const c = ok(withSections(section("image", { id: "imgaaaaaa1" }), section("image", { id: "imgbbbbbb2" }), section("image", { id: "imgcccccc3", mediaId: "b".repeat(32) }), section("text")));
  assert.deepEqual(mediaIdsIn(c).sort(), ["a".repeat(32), "b".repeat(32)]);
});

test("the biggest allowed content still fits the size cap, and anything past it is refused", () => {
  const sections = Array.from({ length: 12 }, (_, i) => section("text", { id: `big${String(i).padStart(8, "0")}`, blocks: Array.from({ length: 12 }, () => ({ kind: "p", runs: [{ text: "x".repeat(1200) }] })) }));
  const r = parseEditableContent(withSections(...sections));
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.issues.some((i) => /too large/.test(i.message)), "oversize content is refused with a size message");
  assert.ok(MAX_CONTENT_BYTES <= 128 * 1024, "the application cap is inside the database's 128 KiB check");
  // a realistic, generous page of added content passes
  ok(withSections(...Array.from({ length: 12 }, (_, i) => section("text", { id: `ok${String(i).padStart(8, "0")}`, blocks: Array.from({ length: 6 }, () => ({ kind: "p", runs: [{ text: "x".repeat(300) }] })) }))));
});
