import { test } from "node:test";
import assert from "node:assert/strict";
import yauzl from "yauzl";
import {
  buildDigestPdf,
  buildDigestXlsx,
  companyCells,
  dayLabel,
  dayWindow,
  digestFileName,
  loadDigestConfig,
  previousUtcDay,
  summaryOf,
  topCounts,
  type DigestData,
} from "../../src/lib/digest/dailyDigest";

function entries(buf: Buffer): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const out = new Map<string, string>();
      zip.on("entry", (e) => {
        zip.openReadStream(e, (err2, st) => {
          if (err2) return reject(err2);
          const parts: Buffer[] = [];
          st.on("data", (d) => parts.push(d));
          st.on("end", () => {
            out.set(e.fileName, Buffer.concat(parts).toString("utf8"));
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => resolve(out));
      zip.readEntry();
    });
  });
}

const company = (n: string, name: string, city: string, sic = "62020", dissolved: Date | null = null) => ({
  companyNumber: n,
  name,
  status: dissolved ? "dissolved" : "active",
  type: "ltd",
  incorporationDate: new Date("2026-11-20T00:00:00Z"),
  dissolutionDate: dissolved,
  sicCodes: sic,
  registeredAddress1: "1 High Street",
  registeredCity: city,
  registeredPostcode: "AB1 2CD",
});

const data: DigestData = {
  day: new Date("2026-11-25T00:00:00Z"),
  newCompanies: [company("01234567", "Acme & Sons <Ltd>", "London", "62020,70229"), company("SC000001", "Beta", "Glasgow"), company("00000003", "Gamma", "london")],
  dissolved: [company("09999999", "Old Co", "Leeds", "", new Date("2026-11-25T00:00:00Z"))],
  officerCompanies: 2,
  directorRows: [
    ["01234567", "Acme & Sons <Ltd>", "active", "SMITH, Jane", "director", "2026-11-20", "", "British", "Engineer"],
    ["SC000001", "Beta", "active", "(no officers listed)", "", "", "", "", ""],
  ],
  truncated: [],
};

test("the digest covers the previous whole UTC day", () => {
  const now = new Date("2026-11-26T06:30:00Z");
  assert.equal(dayLabel(previousUtcDay(now)), "2026-11-25");
  const w = dayWindow(new Date("2026-11-25T17:45:00Z"));
  assert.equal(w.start.toISOString(), "2026-11-25T00:00:00.000Z");
  assert.equal(w.end.toISOString(), "2026-11-26T00:00:00.000Z");
  // Just after midnight UTC the previous day is the one that has just ended.
  assert.equal(dayLabel(previousUtcDay(new Date("2026-12-01T00:00:01Z"))), "2026-11-30");
});

test("config: off by default, numbers are bounded", () => {
  const off = loadDigestConfig({});
  assert.equal(off.enabled, false);
  assert.equal(off.hourUtc, 6);
  assert.equal(off.keepDays, 30);
  const on = loadDigestConfig({ DAILY_DIGEST_ENABLED: "1", DAILY_DIGEST_UTC_HOUR: "30", DAILY_DIGEST_KEEP_DAYS: "0", DAILY_DIGEST_MAX_ROWS: "5" });
  assert.equal(on.enabled, true);
  assert.equal(on.hourUtc, 23);
  assert.equal(on.keepDays, 1);
  assert.equal(on.maxRows, 1000);
});

test("summary counts towns case-insensitively and splits SIC codes", () => {
  const s = summaryOf(data);
  assert.equal(s.newCompanies, 3);
  assert.equal(s.dissolved, 1);
  assert.equal(s.directorRows, 2);
  assert.deepEqual(s.topTowns[0], ["LONDON", 2]);
  assert.deepEqual(s.topSic[0], ["62020", 3]);
  assert.deepEqual(topCounts(["b", "a", "b", " ", "a", "c"], 2), [["a", 2], ["b", 2]]);
});

test("company cells keep leading zeros as text and format dates", () => {
  const cells = companyCells(company("00000003", "Gamma", "London", "62020;70229"));
  assert.equal(cells[0], "00000003");
  assert.equal(cells[4], "2026-11-20");
  assert.equal(cells[6], "62020, 70229");
});

test("the workbook has Summary, New companies, Dissolved and Directors sheets with every row, escaped", async () => {
  const files = await entries(buildDigestXlsx(data, new Date("2026-11-26T06:00:00Z")));
  const wb = files.get("xl/workbook.xml")!;
  for (const name of ["Summary", "New companies", "Dissolved", "Directors"]) assert.match(wb, new RegExp(`name="${name}"`));
  assert.ok(files.has("xl/worksheets/sheet4.xml"));
  assert.ok(!files.has("xl/worksheets/sheet5.xml"));
  assert.match(files.get("[Content_Types].xml")!, /sheet4\.xml/);
  const newSheet = files.get("xl/worksheets/sheet2.xml")!;
  assert.match(newSheet, /Acme &amp; Sons &lt;Ltd&gt;/);
  assert.match(newSheet, /<t xml:space="preserve">01234567<\/t>/);
  assert.equal((newSheet.match(/<row /g) ?? []).length, 4); // header + 3
  assert.match(files.get("xl/worksheets/sheet4.xml")!, /SMITH, Jane/);
  assert.match(files.get("xl/worksheets/sheet1.xml")!, /2026-11-25/);
});

test("the PDF summary is a real PDF", async () => {
  const pdf = await buildDigestPdf(data, new Date("2026-11-26T06:00:00Z"));
  assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.ok(pdf.length > 1500);
  const empty = await buildDigestPdf({ ...data, newCompanies: [], dissolved: [], officerCompanies: 0, directorRows: [] });
  assert.equal(empty.subarray(0, 5).toString("latin1"), "%PDF-");
});

test("file names are dated and safe", () => {
  assert.equal(digestFileName(new Date("2026-11-25T13:00:00Z"), "xlsx"), "director-ltd-daily-digest-2026-11-25.xlsx");
  assert.equal(digestFileName(new Date("2026-11-25T00:00:00Z"), "pdf"), "director-ltd-daily-digest-2026-11-25.pdf");
});
