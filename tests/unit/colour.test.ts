import { test } from "node:test";
import assert from "node:assert/strict";
import { BRAND_SWATCHES, HEX, contrastLevel, contrastRatio, hexToHsv, hexToRgb, hsvToHex, isHex, luminance, parseHex, rgbToHex } from "@/lib/site-content/colour";

test("parseHex accepts what people type and returns one canonical lower-case spelling", () => {
  assert.equal(parseHex("#2457E8"), "#2457e8");
  assert.equal(parseHex("2457e8"), "#2457e8");
  assert.equal(parseHex("  #ABC "), "#aabbcc");
  assert.equal(parseHex("fff"), "#ffffff");
});

test("parseHex refuses everything that is not a six (or three) digit hex colour: no names, functions, urls or css", () => {
  for (const bad of ["", "#", "#12", "#12345", "#1234567", "#12345g", "red", "rgb(1,2,3)", "hsl(0 0% 0%)", "var(--x)", "url(x)", "#fff; background:red", "#fff}", "javascript:alert(1)", "#ff00ff00", "transparent", "\u0000#fff"]) {
    assert.equal(parseHex(bad), null, JSON.stringify(bad));
  }
});

test("HEX / isHex only allow the canonical form", () => {
  assert.ok(isHex("#2457e8"));
  assert.ok(!isHex("#2457E8"), "upper case is normalised before it is stored, never stored");
  assert.ok(!isHex(5));
  assert.ok(!isHex("#fff"));
  assert.ok(HEX.test("#000000"));
});

test("hsv and rgb round trip for every primary and a spread of colours", () => {
  for (const hex of ["#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#1a56e8", "#0b2a6f", "#b45309", "#7f7f7f", "#2457e8"]) {
    assert.equal(hsvToHex(hexToHsv(hex)), hex, hex);
    assert.equal(rgbToHex(hexToRgb(hex)), hex);
  }
  assert.deepEqual(hexToHsv("#ff0000"), { h: 0, s: 1, v: 1 });
  assert.equal(hsvToHex({ h: 120, s: 1, v: 1 }), "#00ff00");
  assert.equal(rgbToHex([300, -5, 12.4]), "#ff000c", "out of range channels are clamped");
});

test("contrast follows WCAG: black on white is 21:1, same colour is 1:1, and the levels are 4.5 / 3", () => {
  assert.equal(Math.round(contrastRatio("#000000", "#ffffff")), 21);
  assert.equal(contrastRatio("#1a56e8", "#1a56e8"), 1);
  assert.ok(luminance("#ffffff") > luminance("#000000"));
  assert.equal(contrastLevel(21), "ok");
  assert.equal(contrastLevel(4.5), "ok");
  assert.equal(contrastLevel(3.2), "large");
  assert.equal(contrastLevel(2), "low");
  assert.equal(contrastLevel(contrastRatio("#777777", "#888888")), "low");
  assert.equal(contrastLevel(contrastRatio("#ffffff", "#1a56e8")), "ok", "white on the brand blue is readable");
});

test("every site swatch is a valid colour", () => {
  for (const s of BRAND_SWATCHES) assert.ok(isHex(s.hex), s.hex);
});
