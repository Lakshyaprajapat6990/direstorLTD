import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BASE, STRONG_PASSWORD, db, makeCompany, sessionFor } from "./helpers";
import { getDirectorDataSummary } from "../../src/lib/data/director-summary";
import { __resetAppointmentEstimate } from "../../src/lib/data/director-progress";
import { REAL_COMPANIES_WHERE } from "../../src/lib/data/scope";
import { findChrome, launchPage } from "../support/browser";

// Real-browser check of the Director Data card on the staff dashboard at phone, tablet, laptop and wide-desktop widths.
//  1. The four register cards keep the height they always had, with real-size figures too, and nothing spills out of the purple card.
//  2. The card and its modal show THREE things only: the estimated director data, the last successful update, the daily Companies House API
//     requests. Each is compared with the database. None of the old processing statistics is on screen.
//  3. The modal opens and closes (Escape, the X, a click on the backdrop), returns focus to the link, fits one desktop view without scrolling,
//     and stacks cleanly on a phone.

after(async () => {
  await db.$disconnect();
});

const chrome = findChrome();
const shots = process.env.SCREENSHOT_DIR ?? path.join(os.tmpdir(), "dl-director-card-shots");
// The ORIGINAL card heights (measured before the Director Data work): no card may be taller than this.
const ORIGINAL_HEIGHTS: Record<number, number[]> = { 390: [194, 194, 187.5, 187.5], 768: [163, 163, 163, 163], 1024: [189.5, 189.5, 189.5, 189.5], 1366: [163, 163, 163, 163], 1440: [163, 163, 163, 163], 1920: [163, 163, 163, 163] };
const WIDTHS: [number, number, boolean][] = [
  [390, 844, true], // phone
  [768, 1024, false], // tablet
  [1024, 768, false], // small laptop (4-column tiles start here)
  [1366, 768, false], // common small laptop screen
  [1440, 900, false], // laptop
  [1920, 1080, false], // wide desktop
];

const TILES = `(() => {
  const section = document.querySelector('section[aria-label="UK company register"]');
  const tiles = [...section.children];
  const rects = tiles.map((t) => t.getBoundingClientRect());
  const director = tiles.findIndex((t) => /with confirmed director data/i.test(t.innerText));
  const spill = [...tiles[director].querySelectorAll("*")].filter((el) => !el.closest("svg[aria-hidden]")).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && (r.right > rects[director].right + 1 || r.left < rects[director].left - 1);
  }).map((el) => el.tagName + ":" + (el.textContent || "").trim().slice(0, 30));
  const rows = {};
  rects.forEach((r, i) => { const k = Math.round(r.top + scrollY); (rows[k] ||= []).push(i); });
  const t = (id) => (document.querySelector("[data-testid='" + id + "']") || {}).textContent;
  const vis = (id) => ((document.querySelector("[data-testid='" + id + "']") || {}).innerText || "").replace(/\\s+/g, " ").trim(); // what is actually visible
  return {
    director,
    heights: rects.map((r) => Math.round(r.height * 10) / 10),
    sameRowAligned: Object.values(rows).every((idx) => idx.every((i) => Math.abs(rects[i].height - rects[idx[0]].height) <= 1)),
    spill,
    overflowX: document.documentElement.scrollWidth - innerWidth,
    texts: tiles.map((x) => x.innerText.replace(/\\s+/g, " ").trim()),
    cardValue: (tiles[director].querySelector("p.tabular-nums") || {}).textContent,
    cardCoverage: ((tiles[director].querySelector("span.whitespace-nowrap") || {}).textContent || "").replace(/\s+/g, " ").trim(),
    barPresent: !!tiles[director].querySelector("[role='img']"),
    link: (() => { const l = document.querySelector("[data-testid='director-progress-open']"); const c = tiles[director].querySelector("div.relative > span"); const num = tiles[director].querySelector("p.tabular-nums"); if (!l) return null; const a = l.getBoundingClientRect(), b = c.getBoundingClientRect(), n = num.getBoundingClientRect(), t = rects[director]; return { text: (l.innerText || "").trim(), inside: a.left >= t.left && a.right <= t.right && a.top >= t.top && a.bottom <= t.bottom, clearOfIcon: a.left >= b.right + 2, clearOfNumber: a.bottom <= n.top + 1 }; })(),
  };
})()`;

const PANEL = `(() => {
  const dlg = document.querySelector('[role="dialog"]');
  if (!dlg) return null;
  const r = dlg.getBoundingClientRect();
  const t = (id) => (document.querySelector("[data-testid='" + id + "']") || {}).textContent;
  const clipped = [...dlg.querySelectorAll("p, h3, span")].filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).display !== "inline").map((el) => (el.textContent || "").trim().slice(0, 40));
  return {
    title: (dlg.querySelector("h2") || {}).textContent, modal: dlg.getAttribute("aria-modal"),
    rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, vw: innerWidth, vh: innerHeight,
    contentOverflowX: dlg.scrollWidth - dlg.clientWidth, clipped,
    imported: t("ds-imported"), today: t("ds-today"), total: t("ds-total"), totalDetail: t("ds-total-detail") || "", update: t("ds-update"),
    apiUsed: t("ds-api-used"), apiCap: t("ds-api-cap"), apiRemaining: t("ds-api-remaining"), note: t("ds-note"), method: t("ds-method"),
    totalSection: (document.querySelector("#ds-total-title").closest("section") || {}).innerText || "",
    h3Count: dlg.querySelectorAll("h3").length,
    cards: Object.fromEntries([...dlg.querySelectorAll("[data-card]")].map((el) => { const r = el.getBoundingClientRect(); return [el.getAttribute("data-card"), { l: r.left, t: r.top, w: r.width, h: r.height, b: r.bottom }]; })),
    content: (() => { const p = dlg.querySelector("[data-testid='director-summary-panel']").getBoundingClientRect(); return { l: p.left, r: p.right, b: p.bottom }; })(),
    eta: t("ds-eta") || "", etaNote: t("ds-eta-note") || "",
    etaHeading: (() => { const h = document.querySelector("[data-testid='ds-eta-title']"); const r = h.getBoundingClientRect(); return { height: r.height, line: parseFloat(getComputedStyle(h).lineHeight) || 20, text: (h.innerText || "").trim(), clipped: h.scrollWidth > h.clientWidth + 1 }; })(),
    text: dlg.textContent || "",
    scrolls: [dlg, ...dlg.querySelectorAll("*")].filter((el) => el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)).length,
    activeIsInside: dlg.contains(document.activeElement), scrollTop: dlg.scrollTop,
  };
})()`;

test("Director Data card: three figures, original card height, a modal that opens, closes, fits one view and matches the database", { skip: chrome ? false : "Chrome is not installed", timeout: 600_000 }, async () => {
  const me = await sessionFor("SUPER_ADMIN", "dircard");
  fs.mkdirSync(shots, { recursive: true });

  // A realistic state in the SCRATCH database: checked live and dissolved companies with director records (current and resigned), a last
  // update a few minutes ago, requests in the shared ledger and a recorded daily cap.
  const created: string[] = [];
  const tag = String(Date.now() % 1_000_000);
  let n = 0;
  const mk = async (over: Record<string, unknown>) => {
    const c = await makeCompany({ companyNumber: `DC${tag}${String(++n).padStart(3, "0")}`, ...over });
    created.push(c.id);
    return c;
  };
  await db.ingestionRun.deleteMany({ where: { kind: "officer_backfill" } });
  await db.officerSyncJob.deleteMany();
  const now = Date.now();
  const lastStamp = new Date(now - 4 * 60_000 - 321);
  for (let i = 0; i < 40; i++) await mk({ officersCoverage: "full", directorCount: 1 + (i % 3), officersFetchedAt: i === 0 ? lastStamp : new Date(now - 86_400_000 * (1 + (i % 5))) });
  for (let i = 0; i < 35; i++) await mk({ status: "dissolved", officersCoverage: "full", directorCount: 2, officersFetchedAt: new Date(now - 86_400_000) });
  // dissolved companies from 2012 that nobody has checked: they have no usable sample, so the estimate must say it leaves them out
  for (let i = 0; i < 3; i++) await mk({ status: "dissolved", dissolutionDate: new Date("2012-06-01") });
  for (let i = 0; i < 30; i++) await mk({ status: i % 5 === 4 ? "liquidation" : "active" });
  for (const id of created.slice(0, 5)) {
    for (const role of ["director", "llp-member"]) await db.director.create({ data: { companyId: id, name: "Seed " + role, role, officerId: "S" + tag + id.slice(-6) + role, source: "rest" } });
    await db.director.create({ data: { companyId: id, name: "Seed resigned", role: "director", resignedOn: new Date("2020-01-01"), officerId: "R" + tag + id.slice(-6), source: "rest" } });
  }
  const dayStart = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  await db.chRequestStat.deleteMany({ where: { bucketStart: { gte: dayStart } } });
  await db.chRequestStat.createMany({ data: [{ bucketStart: new Date(dayStart.getTime() + 1_000), quotaClass: "backfill", requests: 1_234 }, { bucketStart: new Date(dayStart.getTime() + 1_000), quotaClass: "user", requests: 21 }] });
  for (const back of [1, 2, 3]) {
    const at = new Date(`${new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10)}T10:00:00.000Z`);
    await db.ingestionRun.create({ data: { kind: "officer_backfill", status: "success", startedAt: at, finishedAt: at, statsJson: JSON.stringify({ crawled: 4_000, processed: 4_000, requests: 4_000, dailyRequestCap: 100_000 }) } });
  }
  await db.ingestionRun.create({ data: { kind: "officer_backfill", status: "running", heartbeatAt: new Date(), statsJson: JSON.stringify({ crawled: 120, processed: 120, requests: 120, dailyRequestCap: 100_000 }) } });

  __resetAppointmentEstimate();
  const truth = await getDirectorDataSummary({ ttlMs: 0, waitForEstimate: true });
  assert.equal(truth.estimate.state, "unavailable", "the seeded dissolved companies have no representative sample, so there is no all-status total");
  assert.equal(truth.api.used, "1,255", "the ledger total (1,234 + 21), not the worker's own 120");
  const roles = ["director", "corporate-director", "nominee-director", "corporate-nominee-director", "llp-member", "llp-designated-member", "corporate-llp-member", "corporate-llp-designated-member"];
  const importedDb = await db.director.count({ where: { role: { in: roles }, company: { source: { not: "seed" } } } });
  assert.equal(truth.imported.value, importedDb.toLocaleString("en-GB"), "the imported count is the Director table's own count");
  const lastIso = (await db.company.aggregate({ where: { source: { not: "seed" }, officersCoverage: { in: ["full", "unavailable"] } }, _max: { officersFetchedAt: true } }))._max.officersFetchedAt!.toISOString();
  assert.equal(truth.lastUpdate.iso, lastIso);

  // The web server keeps its own caches (30 s for the reads, 15 minutes for the estimate): wait until the page shows the seeded figures.
  const cookie = { cookie: `director_session=${me.cookie}` };
  let served = "";
  // (the server keeps its own estimate for 15 minutes, from whenever it was last calculated, so only the actual figures are compared exactly)
  // (the figures reach the page as the modal's data, so they are in the page payload even while the modal is closed)
  const shown = () => served.includes("1,255") && served.includes(truth.imported.value as string) && /Not yet available|Calculating|≈ [0-9.,]+[KM]?/.test(served);
  const importedTodayDb = await db.director.count({ where: { createdAt: { gte: dayStart }, role: { in: roles }, company: { source: { not: "seed" } } } });
  // The register figures (the card's count and its coverage) are cached by the server for 5 minutes; when the suite has already loaded the
  // dashboard recently, wait for that cache to expire so the page shows the seeded state.
  const seededConfirmed = await db.company.count({ where: { ...REAL_COMPANIES_WHERE, officersCoverage: "full", directorCount: { gt: 0 } } });
  const registerShown = () => served.replace(/<!--[\s\S]*?-->/g, "").includes(`>${seededConfirmed.toLocaleString("en-US")}<`);
  for (let i = 0; i < 400 && !(shown() && registerShown()); i++) {
    served = await (await fetch(`${BASE}/dashboard`, { headers: cookie })).text();
    if (!(shown() && registerShown())) await new Promise((r) => setTimeout(r, 1_000));
  }
  assert.ok(registerShown(), "the dashboard server has picked up the seeded register figures");
  assert.ok(shown(), "the dashboard server has picked up the seeded ledger and estimate");

  const page = await launchPage(9340 + Math.floor(Math.random() * 400));
  const closed = async (what: string) => {
    await page.waitFor(`document.querySelector('[role="dialog"]') === null`, 5_000);
    await page.waitFor(`document.activeElement && document.activeElement.getAttribute("data-testid") === "director-progress-open"`, 2_000).catch(() => {});
    assert.equal(await page.eval(`document.activeElement && document.activeElement.getAttribute("data-testid")`), "director-progress-open", `focus returns to the link after closing with ${what}`);
  };
  const toInt = (s: string) => Number(String(s).replace(/[^0-9]/g, ""));
  const confirmedCompanies = await db.company.count({ where: { ...REAL_COMPANIES_WHERE, officersCoverage: "full", directorCount: { gt: 0 } } });
  const totalUk = await db.company.count({ where: REAL_COMPANIES_WHERE });
  try {
    await page.setViewport(1440, 900);
    await page.goto(`${BASE}/login`);
    await page.type('input[type="email"]', me.email);
    await page.type('input[type="password"]', STRONG_PASSWORD);
    await page.eval(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("Sign in")).click()`);
    await page.waitFor(`location.pathname !== "/login"`);

    for (const [w, h, mobile] of WIDTHS) {
      const where = `at ${w}px`;
      await page.setViewport(w, h, mobile);
      await page.goto(`${BASE}/dashboard`);
      await page.waitFor(`document.querySelector("[data-testid='director-progress-open']") !== null`, 30_000);
      const card = await page.eval<Record<string, any>>(TILES); // eslint-disable-line @typescript-eslint/no-explicit-any
      await page.screenshot(path.join(shots, `dashboard-${w}-card.png`), false);

      // ---- the four cards keep their original height and line up ----
      const nearOriginal = (hs: number[]) => hs.every((v, i) => v <= ORIGINAL_HEIGHTS[w][i] + 2.5);
      assert.ok(nearOriginal(card.heights), `no card is taller than its original height ${where}: ${JSON.stringify(card.heights)} vs ${JSON.stringify(ORIGINAL_HEIGHTS[w])}`);
      assert.ok(card.sameRowAligned, `the cards in each row have equal heights ${where}`);
      assert.ok(card.overflowX <= 1, `no sideways page scroll ${where}`);
      // (the original card's nowrap coverage text is a little wider than a half-width phone tile once the percentage has digits: that is how the
      // original card always looked and is kept; nothing ELSE may spill, in particular not the new link)
      assert.deepEqual(card.spill.filter((x: string) => !/coverage/.test(x)), [], `nothing but the original coverage text spills out of the purple card ${where}`);

      // ---- the card: the ORIGINAL one: companies with confirmed director data, the purple coverage bar and the link ----
      assert.equal(toInt(card.cardValue), confirmedCompanies, `the main figure is the number of COMPANIES with confirmed director data, from the database ${where}`);
      assert.notEqual(toInt(card.cardValue), importedDb, `...and not the number of appointment records ${where}`);
      assert.match(card.cardCoverage, /^[0-9.]+% director data coverage$/, `the coverage wording ${where}: ${card.cardCoverage}`);
      assert.ok(Math.abs(parseFloat(card.cardCoverage) - (confirmedCompanies / totalUk) * 100) < ((confirmedCompanies / totalUk) * 100 < 10 ? 0.006 : 0.051), `coverage = confirmed / all UK companies ${where}: ${card.cardCoverage}`);
      assert.ok(card.barPresent, `the purple progress bar is there ${where}`);
      const text: string = card.texts[card.director];
      assert.match(text, /WITH CONFIRMED DIRECTOR DATA/i);
      for (const gone of ["Appointment records", "imported", "Est.", "API", "Updated", "written today", "Estimated"]) assert.ok(!text.includes(gone), `the card does not carry "${gone}" ${where}`);
      assert.match(card.link.text, /^(View processing progress|Processing progress|Progress)$/, `the link ${where}: ${card.link.text}`);
      assert.ok(card.link.inside && card.link.clearOfIcon, `the link sits inside the card, beside the icon, overlapping nothing ${where}: ${JSON.stringify(card.link)}`);
      assert.ok(card.heights.every((v: number, i: number) => Math.abs(v - ORIGINAL_HEIGHTS[w][i]) <= 2.5), `the four cards have exactly their original size ${where}: ${JSON.stringify(card.heights)} vs ${JSON.stringify(ORIGINAL_HEIGHTS[w])}`);

      // ---- open the modal ----
      assert.equal(await page.eval(`document.querySelector('[role="dialog"]')`), null, `closed by default ${where}`);
      await page.click("[data-testid='director-progress-open']");
      await page.waitFor(`document.querySelector('[role="dialog"]') !== null`, 5_000);
      const open = await page.eval<Record<string, any>>(PANEL); // eslint-disable-line @typescript-eslint/no-explicit-any
      await page.screenshot(path.join(shots, `dashboard-${w}-panel.png`), false);
      assert.equal(open.title, "Director data");
      assert.equal(open.modal, "true");
      assert.ok(open.activeIsInside, `focus moves into the modal ${where}`);
      assert.equal(open.scrollTop, 0, `the modal opens at its top ${where}`);
      assert.ok(open.rect.left >= 0 && open.rect.top >= 0 && open.rect.right <= open.vw && open.rect.bottom <= open.vh, `the modal fits the viewport ${where} ${JSON.stringify(open.rect)} in ${open.vw}x${open.vh}`);
      assert.ok(open.contentOverflowX <= 1 && open.clipped.length === 0, `nothing in the modal is cut off ${where} ${JSON.stringify(open.clipped)}`);
      assert.ok(open.scrolls === 0 || w < 1024, `all three figures fit one view without scrolling on desktop ${where}`);

      // the FIVE groups, with their exact names, and nothing else
      for (const title of ["Last Successful Update", "Total API Requests Today", "Director Data Imported Today", "Total Director Data Imported", "Estimated Total Director Data", "Estimated Time to Complete"]) assert.ok(open.text.includes(title), `the modal shows "${title}" ${where}`);
      assert.equal(open.h3Count, 6, `exactly six information groups ${where}`);
      assert.ok(open.text.includes("Appointment records stored (not companies)"), `the imported count says it counts records, not companies ${where}`);
      // the time to complete: a duration + date + records-a-day pace, or a plain status; the heading is ONE line
      assert.equal(open.etaHeading.text, "Estimated Time to Complete");
      assert.ok(open.etaHeading.height <= open.etaHeading.line * 1.3 && !open.etaHeading.clipped, `the ETA heading is on one line ${where}: ${JSON.stringify(open.etaHeading)}`);
      assert.match(open.eta, /^(Not yet available|Collecting import history|No recent imports|Complete|about [0-9.]+ (day|days|weeks|months|years))$/, `the estimated time to complete ${where}: ${open.eta}`);
      if (/^about/.test(open.eta)) assert.match(open.etaNote.replace(/\s+/g, " "), /^Estimated completion [0-9]{1,2} [A-Z][a-z]{2} 20[0-9]{2} · based on [0-9,]+ records a day \(last [0-9]+ days\) · an estimate, not a deadline$/, `a duration, an estimated date, the records-a-day pace, and plainly an estimate ${where}: ${open.etaNote}`);
      else assert.equal(open.etaNote, "", `no date or pace beside a status ${where}`);
      // ---- the layout: row 1 two colourful cards, row 2 three compact cards, row 3 the time to complete; nothing empty, nothing overflowing ----
      const c = open.cards;
      assert.deepEqual(Object.keys(c).sort(), ["api", "eta", "imported", "today", "total", "update"], `six cards ${where}`);
      const same = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;
      if (w >= 768) {
        assert.ok(same(c.imported.t, c.total.t) && same(c.imported.h, c.total.h) && same(c.imported.w, c.total.w, 3), `row 1: the two colourful cards side by side, same top, height and width ${where}: ${JSON.stringify([c.imported, c.total])}`);
        assert.ok(c.imported.l < c.total.l && same(c.imported.l, open.content.l) && same(c.total.l + c.total.w, open.content.r), `row 1 fills the modal's width, imported on the left ${where}`);
        assert.ok(same(c.update.t, c.api.t) && same(c.api.t, c.today.t) && same(c.update.h, c.api.h) && same(c.api.h, c.today.h), `row 2: three compact cards on one line, equal heights ${where}: ${JSON.stringify([c.update, c.api, c.today])}`);
        assert.ok(same(c.update.l, open.content.l) && same(c.today.l + c.today.w, open.content.r), `row 2 fills the modal's width ${where}`);
        assert.ok(c.update.t >= c.imported.b && c.eta.t >= c.update.b, `rows in order: colourful, compact, time to complete ${where}`);
      } else {
        const order = ["imported", "total", "update", "api", "today", "eta"];
        for (let i = 1; i < order.length; i++) assert.ok(c[order[i]].t >= c[order[i - 1]].b - 1 && same(c[order[i]].l, c[order[0]].l) && same(c[order[i]].w, c[order[0]].w), `phone: one column, in order ${where}`);
      }
      assert.ok(same(c.eta.l, open.content.l) && same(c.eta.w, open.content.r - open.content.l, 3), `row 3: the time to complete is full width ${where}`);
      assert.ok(open.content.b - c.eta.b <= 8, `no empty space below the last card ${where}: ${open.content.b - c.eta.b}px`);
      assert.equal(open.update, truth.lastUpdate.text, `the last successful update is the database timestamp ${where}`);
      assert.equal(open.apiUsed, "1,255", `API requests used today (shared ledger) ${where}`);
      assert.equal(open.apiCap, "100,000", `the daily limit ${where}`);
      assert.equal(toInt(open.apiUsed) + toInt(open.apiRemaining), toInt(open.apiCap), `used + remaining = the limit ${where}`);
      assert.equal(toInt(open.today), importedTodayDb, `Director Data Imported Today = the director rows inserted today (UTC), from the database ${where}`);
      assert.ok(importedTodayDb > 0, "the seeded state has records imported today");
      assert.equal(open.imported, truth.imported.value, `Total Director Data Imported is the database count ${where}`);
      assert.equal(toInt(open.imported), importedDb);
      // Estimated total: ONE rounded approximate figure across all statuses, or NOTHING (never a live-only total). The web server keeps its stratum
      // totals for an hour, so when it computed them before this seed existed it can still hold a complete-looking estimate: a figure is accepted
      // (its wording is pinned exactly by the unit and integration tests).
      if (open.total === "Not yet available") {
        assert.ok(!/≈/.test(open.text), `no estimate figure of any kind ${where}`);
      } else {
        assert.match(open.total, /^≈ [0-9.,]+[KM]?$/, `one rounded approximate total ${where}: ${open.total}`);
        assert.match(open.totalDetail.replace(/\s+/g, " "), /^Estimated appointment records across UK companies$/, `labelled as estimated appointment records ${where}`);
      }
      // minimal: no breakdowns, no methodology, no warnings, no ETA / remaining / range, no company-status statistics
      for (const gone of ["Estimated Records Remaining", "ETA unavailable", "Awaiting", "Range", "Live companies only", "Partial estimate", "How is this calculated?", "Provisional", "have no usable sample", "Eligible", "Successfully Checked", "Processed Today", "Average Daily Rate", "Confirmed Director Data Coverage", "Active", "Dissolved", "Appointments written today", "current ", "historical "]) {
        assert.ok(!open.text.includes(gone), `the modal does not carry "${gone}" ${where}`);
      }

      // ---- close it three ways ----
      await page.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`);
      await closed("Escape");
      await page.click("[data-testid='director-progress-open']");
      await page.waitFor(`document.querySelector('[role="dialog"]') !== null`, 5_000);
      await page.click('[role="dialog"] button[aria-label="Close"]');
      await closed("the X");
      await page.click("[data-testid='director-progress-open']");
      await page.waitFor(`document.querySelector('[role="dialog"]') !== null`, 5_000);
      await page.mouseClick(4, 4); // the dark backdrop outside the panel
      await closed("a click on the backdrop");
      assert.deepEqual((await page.eval<Record<string, any>>(TILES)).heights, card.heights, `after closing, every card is as it was ${where}`); // eslint-disable-line @typescript-eslint/no-explicit-any

      // ---- a real-size confirmed count (about half a million companies): the original card still has its size and nothing spills ----
      if (w === 1366 || w === 1024 || w === 390) {
        await page.eval(`(() => { const sec = document.querySelector('section[aria-label="UK company register"]'); const t = [...sec.children].find((x) => /with confirmed director data/i.test(x.innerText)); t.querySelector("p.tabular-nums").textContent = "499,999"; })()`);
        const real = await page.eval<Record<string, any>>(TILES); // eslint-disable-line @typescript-eslint/no-explicit-any
        await page.screenshot(path.join(shots, `dashboard-${w}-realsize.png`), false);
        assert.ok(real.heights.every((v: number, i: number) => Math.abs(v - ORIGINAL_HEIGHTS[w][i]) <= 2.5) && real.sameRowAligned, `with a real-size count the cards keep their original size ${where}: ${JSON.stringify(real.heights)}`);
        assert.ok(real.link.inside && real.link.clearOfIcon, `...and the link stays inside the card ${where}`);
      }
    }
  } finally {
    await page.close();
    await db.officerSyncJob.deleteMany({ where: { companyId: { in: created } } });
    await db.company.deleteMany({ where: { id: { in: created } } });
    await db.ingestionRun.deleteMany({ where: { kind: "officer_backfill" } });
    await db.chRequestStat.deleteMany({ where: { bucketStart: { gte: dayStart } } });
  }
});
