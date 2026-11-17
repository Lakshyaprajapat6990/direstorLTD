import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BASE, db } from "./helpers";
import { findChrome, launchPage } from "../support/browser";

// The public home page's big "UK companies loaded" figure stays on ONE line at every width, with the length of the real register (14,037,575):
// its size follows the width of its own card instead of letting the last digit wrap onto a second line.
after(async () => {
  await db.$disconnect();
});

interface Measured { em: number; cardW: number; sizes: string[]; text: string; fontSize: number; lineHeight: number; height: number; textRight: number; cardRight: number; cardPadRight: number; lines: number }

const chrome = findChrome();
const shots = process.env.SCREENSHOT_DIR ?? path.join(os.tmpdir(), "dl-home-stat-shots");

test("public home: the company count is one line at every width, even with 14,037,575", { skip: chrome ? false : "Chrome is not installed", timeout: 180_000 }, async () => {
  fs.mkdirSync(shots, { recursive: true });
  const page = await launchPage(9740 + Math.floor(Math.random() * 200));
  try {
    for (const [w, h, mobile] of [
      [320, 640, true],
      [390, 844, true],
      [768, 1024, false],
      [1024, 768, false],
      [1280, 800, false],
      [1366, 768, false],
      [1440, 900, false],
      [1920, 1080, false],
    ] as [number, number, boolean][]) {
      await page.setViewport(w, h, mobile);
      await page.goto(`${BASE}/`);
      await page.waitFor(`document.querySelector("[data-fit-stat] > p:first-child") !== null`, 30_000);
      await new Promise((r) => setTimeout(r, 1_500)); // let the count-up animation finish
      await page.eval(`(() => { document.querySelector("[data-fit-stat] > p:first-child").textContent = "14,037,575"; })()`);
      const m = await page.eval<Measured>(`(() => {
        const p = document.querySelector("[data-fit-stat] > p:first-child");
        const card = p.parentElement;
        const r = p.getBoundingClientRect(), c = card.getBoundingClientRect();
        const fs = parseFloat(getComputedStyle(p).fontSize);
        const lh = parseFloat(getComputedStyle(p).lineHeight);
        const range = document.createRange(); range.selectNodeContents(p);
        const lines = new Set([...range.getClientRects()].map((q) => Math.round(q.top))).size;
        const sizes = [...document.querySelectorAll("[data-fit-stat] > p:first-child")].map((e) => { const s = getComputedStyle(e); return s.fontSize + "/" + s.fontWeight + "/" + s.fontFamily + "/" + s.color; });
        const textW = Math.max(...[...range.getClientRects()].map((q) => q.right)) - Math.min(...[...range.getClientRects()].map((q) => q.left));
        return { em: textW / fs, cardW: c.width, sizes, text: p.textContent, fontSize: fs, lineHeight: isNaN(lh) ? fs * 1.5 : lh, height: r.height, textRight: Math.max(...[...range.getClientRects()].map((q) => q.right)), cardRight: c.right, cardPadRight: parseFloat(getComputedStyle(card).paddingRight), scrollOverflow: p.scrollWidth - p.clientWidth, lines, pageOverflowX: document.documentElement.scrollWidth - innerWidth };
      })()`);
      await page.eval(`document.querySelector("[data-fit-stat] > p:first-child").scrollIntoView({ block: "center" })`);
      await new Promise((r) => setTimeout(r, 400));
      await page.screenshot(path.join(shots, `home-${w}.png`), false);
      assert.equal(m.lines, 1, `the figure is on ONE line at ${w}px: ${JSON.stringify(m)}`);
      assert.ok(m.height <= m.lineHeight * 1.3, `...one line high at ${w}px: ${JSON.stringify(m)}`);
      assert.ok(m.textRight <= m.cardRight - m.cardPadRight + 1, `...and inside its card at ${w}px: ${JSON.stringify(m)}`);
      console.log(`home figure @${w}: card ${Math.round(m.cardW)}px, font ${m.fontSize.toFixed(1)}px, text ${m.em.toFixed(2)}em`);
      assert.equal(m.sizes.length, 4, "total, active, dissolved and directors all use the fitted figure");
      assert.equal(new Set(m.sizes).size, 1, `all the company-count figures share exactly the same size, weight and style at ${w}px: ${JSON.stringify(m.sizes)}`);
      assert.ok(m.fontSize >= 17 && m.fontSize <= 30.1, `...at a readable size at ${w}px (${m.fontSize}px)`);
      // (the page's own scroll width is not asserted: the public page's animated logo ticker, "marquee", is wider than the window by design)
    }
  } finally {
    await page.close();
  }
});
