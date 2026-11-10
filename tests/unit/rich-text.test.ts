import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearFormatting,
  covered,
  makeRich,
  mapRange,
  normalizeRuns,
  richAlign,
  richPlain,
  richRuns,
  runsText,
  selectionState,
  setMark,
  toggleMark,
  validateHref,
  type Run,
} from "@/lib/site-content/rich";

const R = (...r: Run[]) => r;

// ---- links ------------------------------------------------------------------------------------------------------------------

test("links: the site's own pages, https:// addresses and mailto: are allowed; everything else is refused", () => {
  for (const ok of ["/login", "#uk-data", "#search", "#filters", "#workflow", "#api", "#faq", "https://example.com", "https://sub.example.co.uk/path?q=1#x", "mailto:hello@example.com"]) assert.equal(validateHref(ok), null, ok);
  for (const bad of [
    "",
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:x",
    "http://example.com",
    "//evil.example",
    "/admin",
    "/dashboard",
    "#random",
    "https://",
    "https://localhost",
    "https://user:pass@example.com",
    "https://example.com/a b",
    'https://example.com/"onmouseover="x',
    "https://example.com/<script>",
    "mailto:not an address",
    "ftp://example.com",
    "file:///etc/passwd",
    "x".repeat(301),
  ]) {
    assert.ok(validateHref(bad), `should be refused: ${bad.slice(0, 40)}`);
  }
});

// ---- canonical form ---------------------------------------------------------------------------------------------------------

test("unformatted text is always a plain string, so content without formatting stays exactly as before", () => {
  assert.equal(makeRich([{ text: "hello" }]), "hello");
  assert.equal(makeRich([{ text: "hel" }, { text: "lo" }]), "hello", "neighbouring identical runs merge");
  assert.equal(makeRich([]), "");
  assert.equal(makeRich([{ text: "  padded  " }]), "padded", "outer whitespace is trimmed in the canonical form");
  assert.equal(makeRich([{ text: "  padded  " }], undefined, false), "  padded  ", "but not while someone is still typing");
});

test("formatted or aligned text is kept as runs, in one canonical spelling", () => {
  assert.deepEqual(makeRich([{ text: "a " }, { text: "b", b: true }, { text: " c" }]), { runs: [{ text: "a " }, { text: "b", b: true }, { text: " c" }] });
  assert.deepEqual(makeRich([{ text: "plain" }], "center"), { runs: [{ text: "plain" }], align: "center" });
  assert.deepEqual(makeRich([{ text: "x", b: true }, { text: "y", b: true }]), { runs: [{ text: "xy", b: true }] });
});

test("normalizeRuns drops empty runs and merges only runs with identical marks", () => {
  assert.deepEqual(normalizeRuns([{ text: "" }, { text: "a", b: true }, { text: "b", b: true }, { text: "c", i: true }, { text: "" }]), [{ text: "ab", b: true }, { text: "c", i: true }]);
  assert.deepEqual(normalizeRuns([{ text: "a", color: "brand" }, { text: "b", color: "navy" }]).length, 2);
});

test("reading helpers treat a string and a run list the same way", () => {
  assert.deepEqual(richRuns("abc"), [{ text: "abc" }]);
  assert.deepEqual(richRuns(""), []);
  assert.equal(richAlign("abc"), undefined);
  assert.equal(richAlign({ runs: [{ text: "x" }], align: "right" }), "right");
  assert.equal(richPlain({ runs: [{ text: "a", b: true }, { text: "b" }] }), "ab");
  assert.equal(runsText(R({ text: "ab" }, { text: "cd" })), "abcd");
});

// ---- editing operations -----------------------------------------------------------------------------------------------------

test("toggleMark formats exactly the selected characters and splits runs at the edges", () => {
  const out = toggleMark(R({ text: "hello world" }), 6, 11, "b");
  assert.deepEqual(out, [{ text: "hello " }, { text: "world", b: true }]);
  assert.equal(runsText(out), "hello world");
});

test("toggleMark switches the mark off again when the whole selection already has it", () => {
  const on = toggleMark(R({ text: "hello world" }), 0, 5, "i");
  assert.deepEqual(toggleMark(on, 0, 5, "i"), [{ text: "hello world" }]);
  // partly formatted selection: the mark is added to all of it first
  const half = R({ text: "ab", b: true }, { text: "cd" });
  assert.deepEqual(toggleMark(half, 0, 4, "b"), [{ text: "abcd", b: true }]);
});

test("a collapsed selection changes nothing", () => {
  assert.deepEqual(toggleMark(R({ text: "abc" }), 2, 2, "b"), [{ text: "abc" }]);
  assert.deepEqual(setMark(R({ text: "abc" }), 1, 1, { color: "brand" }), [{ text: "abc" }]);
});

test("colour, size and link are set and cleared on a range", () => {
  let r = setMark(R({ text: "one two three" }), 4, 7, { color: "danger", size: "lg" });
  assert.deepEqual(r, [{ text: "one " }, { text: "two", color: "danger", size: "lg" }, { text: " three" }]);
  r = setMark(r, 4, 7, { clear: ["color"] });
  assert.deepEqual(r[1], { text: "two", size: "lg" });
  r = setMark(r, 0, 3, { href: "/login" });
  assert.deepEqual(r[0], { text: "one", href: "/login" });
  r = setMark(r, 0, 3, { clear: ["href"] });
  assert.deepEqual(r[0], { text: "one " }, "runs that look the same again merge back together");
});

test("clearFormatting removes every mark in the range and keeps the text", () => {
  const r = R({ text: "ab", b: true, color: "brand", href: "/login" }, { text: "cd", i: true });
  assert.deepEqual(clearFormatting(r, 0, 4), [{ text: "abcd" }]);
  assert.deepEqual(clearFormatting(r, 1, 3), [{ text: "a", b: true, color: "brand", href: "/login" }, { text: "bc" }, { text: "d", i: true }]);
});

test("selection state shows a mark only when every selected character has it", () => {
  const r = R({ text: "ab", b: true, color: "brand" }, { text: "cd", b: true });
  assert.deepEqual(selectionState(r, 0, 4), { b: true, i: false, u: false, color: undefined, bg: undefined, size: undefined, font: undefined, href: undefined });
  assert.equal(selectionState(r, 0, 2).color, "brand");
  assert.equal(selectionState(R({ text: "ab", b: true }, { text: "cd" }), 0, 4).b, false);
  assert.equal(selectionState(r, 2, 2).b, false, "empty selection");
});

test("covered() and mapRange() never lose or duplicate text, whatever the offsets", () => {
  const base = R({ text: "alpha ", b: true }, { text: "beta" }, { text: " gamma", i: true });
  const total = runsText(base).length;
  for (let a = 0; a <= total; a++) {
    for (let b = a; b <= total; b++) {
      assert.equal(runsText(mapRange(base, a, b, (r) => ({ ...r, u: true }))), runsText(base), `mapRange ${a}-${b}`);
      assert.equal(runsText(covered(base, a, b)).length, b - a, `covered ${a}-${b}`);
    }
  }
});
