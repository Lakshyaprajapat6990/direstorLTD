import PDFDocument from "pdfkit";
import { db } from "@/lib/db";
import { buildWorkbook, type WorkbookSheet } from "@/lib/reports/xlsx";
import { pdfSafe } from "@/lib/reports/documents";
import { finishRun, startRun, touchRun } from "@/lib/jobs/runs";

// Daily Companies House digest: once per UTC day the scheduler collects what the background jobs brought in during the
// PREVIOUS UTC day and turns it into
//   - an Excel workbook with every row (Summary, New companies, Dissolved, Directors), and
//   - a short PDF summary (totals, top towns and industries, the first companies of each list),
// and stores both in the DailyDigest table (no writable disk needed), where a Super Admin downloads them from
// Super Admin > Daily digests.
//
// "What came in that day" is read from the database, never from Companies House, so the digest costs NO API requests:
//   New companies = companies first stored that day (createdAt), i.e. what the new-registrations job added;
//   Dissolved     = companies whose dissolution date is that day (Companies House publishes these with a delay of a few
//                   days, so a late dissolution appears in the digest of the day it is dated, which may already be sent);
//   Directors     = companies whose officers were fetched that day (officersFetchedAt), one row per officer - this is the
//                   ~OFFICER_DAILY_REQUEST_CAP companies the officer worker processes per day.
// Synthetic development rows (source "seed") are never included.

type Cell = string | number;
type Log = (message: string) => void;

export interface DigestConfig {
  enabled: boolean;
  hourUtc: number;
  keepDays: number;
  maxRows: number;
}

export function loadDigestConfig(env: Record<string, string | undefined> = process.env): DigestConfig {
  const read = (name: string, fallback: number) => {
    const v = env[name];
    return v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : fallback;
  };
  return {
    enabled: env.DAILY_DIGEST_ENABLED === "1",
    hourUtc: Math.min(23, Math.max(0, read("DAILY_DIGEST_UTC_HOUR", 6))),
    keepDays: Math.max(1, read("DAILY_DIGEST_KEEP_DAYS", 30)),
    // Excel holds 1,048,576 rows per sheet; the default keeps a day's workbook a comfortable download.
    maxRows: Math.min(1_000_000, Math.max(1_000, read("DAILY_DIGEST_MAX_ROWS", 250_000))),
  };
}

// ---- Dates ----------------------------------------------------------------------------------------------------------
export const utcDay = (d: Date) => new Date(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`);
export const previousUtcDay = (now: Date) => new Date(utcDay(now).getTime() - 86_400_000);
export const dayWindow = (day: Date) => ({ start: utcDay(day), end: new Date(utcDay(day).getTime() + 86_400_000) });
export const dayLabel = (day: Date) => utcDay(day).toISOString().slice(0, 10);
const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "");

// Due when switched on, the hour has passed, and the previous day has no digest yet. Restart-safe: decided from the table.
export async function dailyDigestDue(now: Date, cfg: DigestConfig = loadDigestConfig()): Promise<boolean> {
  if (!cfg.enabled || now.getUTCHours() < cfg.hourUtc) return false;
  const existing = await db.dailyDigest.findUnique({ where: { day: previousUtcDay(now) }, select: { id: true } });
  return !existing;
}

// ---- Data -----------------------------------------------------------------------------------------------------------
const companySelect = {
  companyNumber: true,
  name: true,
  status: true,
  type: true,
  incorporationDate: true,
  dissolutionDate: true,
  sicCodes: true,
  registeredAddress1: true,
  registeredCity: true,
  registeredPostcode: true,
} as const;

export const COMPANY_HEADERS = ["Company number", "Company name", "Status", "Type", "Incorporated", "Dissolved", "SIC codes", "Address", "Town", "Postcode"];
export const DIRECTOR_HEADERS = ["Company number", "Company name", "Company status", "Officer name", "Role", "Appointed", "Resigned", "Nationality", "Occupation"];

type CompanyRow = {
  companyNumber: string;
  name: string;
  status: string;
  type: string;
  incorporationDate: Date;
  dissolutionDate: Date | null;
  sicCodes: string;
  registeredAddress1: string;
  registeredCity: string;
  registeredPostcode: string;
};

export function companyCells(c: CompanyRow): Cell[] {
  return [c.companyNumber, c.name, c.status, c.type, ymd(c.incorporationDate), ymd(c.dissolutionDate), c.sicCodes.split(/[,;]\s*/).filter(Boolean).join(", "), c.registeredAddress1, c.registeredCity, c.registeredPostcode];
}

export interface DigestData {
  day: Date;
  newCompanies: CompanyRow[];
  dissolved: CompanyRow[];
  officerCompanies: number;
  directorRows: Cell[][];
  truncated: string[];
}

const PAGE = 2_000;

export async function loadDigestData(day: Date, cfg: DigestConfig = loadDigestConfig()): Promise<DigestData> {
  const { start, end } = dayWindow(day);
  const truncated: string[] = [];

  const newCompanies = await db.company.findMany({
    where: { createdAt: { gte: start, lt: end }, source: { not: "seed" } },
    select: companySelect,
    orderBy: [{ incorporationDate: "desc" }, { companyNumber: "asc" }],
    take: cfg.maxRows + 1,
  });
  if (newCompanies.length > cfg.maxRows) {
    newCompanies.length = cfg.maxRows;
    truncated.push(`New companies limited to ${cfg.maxRows.toLocaleString("en-GB")} rows`);
  }

  const dissolved = await db.company.findMany({
    where: { dissolutionDate: { gte: start, lt: end }, source: { not: "seed" } },
    select: companySelect,
    orderBy: { companyNumber: "asc" },
    take: cfg.maxRows + 1,
  });
  if (dissolved.length > cfg.maxRows) {
    dissolved.length = cfg.maxRows;
    truncated.push(`Dissolved companies limited to ${cfg.maxRows.toLocaleString("en-GB")} rows`);
  }

  // Officers: paged by id so a 30,000-company day never loads in one query.
  const directorRows: Cell[][] = [];
  let officerCompanies = 0;
  let cursor: string | undefined;
  for (;;) {
    const page = await db.company.findMany({
      where: { officersFetchedAt: { gte: start, lt: end }, officersCoverage: "full", source: { not: "seed" } },
      select: {
        id: true,
        companyNumber: true,
        name: true,
        status: true,
        directors: { select: { name: true, role: true, appointedOn: true, resignedOn: true, nationality: true, occupation: true }, orderBy: [{ resignedOn: { sort: "asc", nulls: "first" } }, { name: "asc" }] },
      },
      orderBy: { id: "asc" },
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (!page.length) break;
    for (const c of page) {
      officerCompanies++;
      const officers = c.directors.length ? c.directors : [null];
      for (const d of officers) {
        if (directorRows.length >= cfg.maxRows) continue;
        directorRows.push([c.companyNumber, c.name, c.status, d?.name ?? "(no officers listed)", d?.role ?? "", ymd(d?.appointedOn), ymd(d?.resignedOn), d?.nationality ?? "", d?.occupation ?? ""]);
      }
    }
    cursor = page[page.length - 1].id;
    if (page.length < PAGE) break;
  }
  if (directorRows.length >= cfg.maxRows) truncated.push(`Directors limited to ${cfg.maxRows.toLocaleString("en-GB")} rows`);

  return { day: utcDay(day), newCompanies, dissolved, officerCompanies, directorRows, truncated };
}

// ---- Summary figures ------------------------------------------------------------------------------------------------
export function topCounts(values: string[], limit = 10): [string, number][] {
  const m = new Map<string, number>();
  for (const v of values) {
    const k = v.trim();
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
}

export function summaryOf(data: DigestData) {
  return {
    day: dayLabel(data.day),
    newCompanies: data.newCompanies.length,
    dissolved: data.dissolved.length,
    officerCompanies: data.officerCompanies,
    directorRows: data.directorRows.length,
    topTowns: topCounts(data.newCompanies.map((c) => c.registeredCity.toUpperCase())),
    topSic: topCounts(data.newCompanies.flatMap((c) => c.sicCodes.split(/[,;]\s*/).filter(Boolean))),
    truncated: data.truncated,
  };
}

// ---- Files ----------------------------------------------------------------------------------------------------------
export function buildDigestXlsx(data: DigestData, generatedAt = new Date()): Buffer {
  const s = summaryOf(data);
  const summaryRows: Cell[][] = [
    ["Day (UTC)", s.day],
    ["New companies", s.newCompanies],
    ["Dissolved companies", s.dissolved],
    ["Companies with directors updated", s.officerCompanies],
    ["Director rows", s.directorRows],
    ["Generated (UTC)", generatedAt.toISOString().replace("T", " ").slice(0, 16)],
    ["Source", "DIRECTOR.LTD (Companies House data)"],
    ...s.truncated.map((t) => ["Note", t] as Cell[]),
  ];
  const sheets: WorkbookSheet[] = [
    { name: "Summary", headers: ["Field", "Value"], rows: summaryRows, table: false, widths: [34, 60] },
    { name: "New companies", headers: COMPANY_HEADERS, rows: data.newCompanies.map(companyCells), table: true },
    { name: "Dissolved", headers: COMPANY_HEADERS, rows: data.dissolved.map(companyCells), table: true },
    { name: "Directors", headers: DIRECTOR_HEADERS, rows: data.directorRows, table: true },
  ];
  return buildWorkbook(sheets);
}

const LIST_ROWS = 40;

export function buildDigestPdf(data: DigestData, generatedAt = new Date()): Promise<Buffer> {
  const s = summaryOf(data);
  const doc = new PDFDocument({ size: "A4", margin: 40, info: { Title: `DIRECTOR.LTD daily digest ${s.day}`, Producer: "DIRECTOR.LTD" } });
  const parts: Buffer[] = [];
  doc.on("data", (c: Buffer) => parts.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(parts)));
    doc.on("error", reject);
  });

  const left = 40;
  const width = doc.page.width - 80;
  const heading = (t: string) => {
    if (doc.y > doc.page.height - 120) doc.addPage();
    doc.moveDown(0.8).font("Helvetica-Bold").fontSize(12).fillColor("#1d4ed8").text(pdfSafe(t), left, doc.y, { width });
    doc.moveDown(0.3);
  };
  const table = (headers: string[], rows: Cell[][], weights: number[]) => {
    const sum = weights.reduce((a, b) => a + b, 0);
    const w = weights.map((x) => (x / sum) * width);
    const row = (cells: Cell[], head: boolean, shade: boolean) => {
      doc.font(head ? "Helvetica-Bold" : "Helvetica").fontSize(8);
      const texts = cells.map((c) => pdfSafe(c));
      const h = Math.max(...texts.map((t, i) => doc.heightOfString(t, { width: w[i] - 6 }))) + 6;
      if (doc.y + h > doc.page.height - 50) {
        doc.addPage();
        if (!head) row(headers, true, false);
      }
      const y = doc.y;
      if (head || shade) doc.save().rect(left, y, width, h).fill(head ? "#e0e7ff" : "#f8fafc").restore();
      doc.fillColor(head ? "#312e81" : "#0f172a");
      let x = left;
      texts.forEach((t, i) => {
        doc.text(t, x + 3, y + 3, { width: w[i] - 6 });
        x += w[i];
      });
      doc.x = left;
      doc.y = y + h;
    };
    row(headers, true, false);
    if (!rows.length) {
      doc.font("Helvetica-Oblique").fontSize(8).fillColor("#64748b").text("None.", left, doc.y + 3);
      return;
    }
    rows.forEach((r, i) => row(r, false, i % 2 === 1));
  };

  doc.font("Helvetica-Bold").fontSize(20).fillColor("#0f172a").text("DIRECTOR.LTD - Daily digest", left, 40, { width });
  doc.font("Helvetica").fontSize(10).fillColor("#475569").text(`Companies House data for ${s.day} (UTC). Generated ${generatedAt.toISOString().replace("T", " ").slice(0, 16)} UTC.`, { width });

  heading("Totals");
  table(
    ["Measure", "Count"],
    [
      ["New companies stored", s.newCompanies.toLocaleString("en-GB")],
      ["Companies dissolved (dated this day)", s.dissolved.toLocaleString("en-GB")],
      ["Companies with directors updated", s.officerCompanies.toLocaleString("en-GB")],
      ["Director / officer rows", s.directorRows.toLocaleString("en-GB")],
    ],
    [3, 1]
  );

  heading("New companies - top towns");
  table(["Town", "New companies"], s.topTowns.map(([k, v]) => [k, v.toLocaleString("en-GB")]), [3, 1]);
  heading("New companies - top SIC codes");
  table(["SIC code", "New companies"], s.topSic.map(([k, v]) => [k, v.toLocaleString("en-GB")]), [3, 1]);

  const short = (c: CompanyRow): Cell[] => [c.companyNumber, c.name, c.registeredCity, ymd(c.incorporationDate)];
  heading(`New companies (first ${Math.min(LIST_ROWS, s.newCompanies)} of ${s.newCompanies.toLocaleString("en-GB")})`);
  table(["Number", "Name", "Town", "Incorporated"], data.newCompanies.slice(0, LIST_ROWS).map(short), [1.2, 4, 1.8, 1.3]);
  heading(`Dissolved companies (first ${Math.min(LIST_ROWS, s.dissolved)} of ${s.dissolved.toLocaleString("en-GB")})`);
  table(["Number", "Name", "Town", "Dissolved"], data.dissolved.slice(0, LIST_ROWS).map((c) => [c.companyNumber, c.name, c.registeredCity, ymd(c.dissolutionDate)]), [1.2, 4, 1.8, 1.3]);

  doc.moveDown(1).font("Helvetica-Oblique").fontSize(8.5).fillColor("#475569");
  doc.text("The full lists, including every director, are in the Excel workbook of the same day.", left, doc.y, { width });
  for (const t of s.truncated) doc.text(pdfSafe(t), left, doc.y, { width });
  doc.end();
  return done;
}

export const digestFileName = (day: Date, ext: "xlsx" | "pdf") => `director-ltd-daily-digest-${dayLabel(day)}.${ext}`;

// ---- Job ------------------------------------------------------------------------------------------------------------
export interface DigestResult {
  day: string;
  status: "success";
  newCompanies: number;
  dissolved: number;
  officerCompanies: number;
  directorRows: number;
  xlsxBytes: number;
  pdfBytes: number;
  removedOld: number;
}

export async function runDailyDigest(opts: { day?: Date; now?: Date; log?: Log; cfg?: DigestConfig } = {}): Promise<DigestResult> {
  const now = opts.now ?? new Date();
  const cfg = opts.cfg ?? loadDigestConfig();
  const day = utcDay(opts.day ?? previousUtcDay(now));
  const log = opts.log ?? (() => {});
  const run = await startRun("daily_digest", { inputName: dayLabel(day) });
  try {
    const data = await loadDigestData(day, cfg);
    await touchRun(run.id);
    const xlsx = buildDigestXlsx(data, now);
    const pdf = await buildDigestPdf(data, now);
    const s = summaryOf(data);
    log(`Daily digest ${s.day}: ${s.newCompanies} new, ${s.dissolved} dissolved, ${s.officerCompanies} companies / ${s.directorRows} director rows`);

    const counts = { newCompanies: s.newCompanies, dissolved: s.dissolved, officerCompanies: s.officerCompanies, directorRows: s.directorRows };
    const files = { xlsx, xlsxBytes: xlsx.length, pdf, pdfBytes: pdf.length };
    await db.dailyDigest.upsert({
      where: { day },
      create: { day, ...counts, ...files },
      update: { ...counts, ...files },
    });

    const removed = await db.dailyDigest.deleteMany({ where: { day: { lt: new Date(utcDay(now).getTime() - cfg.keepDays * 86_400_000) } } });
    const result: DigestResult = { day: s.day, status: "success", ...counts, xlsxBytes: xlsx.length, pdfBytes: pdf.length, removedOld: removed.count };
    await finishRun(run.id, "success", {
      rowsRead: s.newCompanies + s.dissolved + s.directorRows,
      rowsInserted: 1,
      rowsProcessed: 1,
      statsJson: JSON.stringify(result),
    });
    return result;
  } catch (err) {
    await finishRun(run.id, "failed", { errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 1000) }).catch(() => {});
    throw err;
  }
}
