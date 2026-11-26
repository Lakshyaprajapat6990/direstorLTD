import { crc32, deflateRawSync } from "node:zlib";
import { xmlSafe, type ReportDocMeta } from "./documents";

// Minimal, dependency-free Excel (.xlsx) writer for report exports: one "Companies" sheet (header row, frozen, filterable,
// text cells so company numbers keep their leading zeros) and a "Report details" sheet with the conditions and counts.
// An .xlsx file is a ZIP of a few XML parts; node:zlib supplies the deflate and CRC-32, so no package is needed.

type Cell = string | number;

const MAX_CELL_CHARS = 32_000; // Excel's hard limit is 32,767 characters per cell
const esc = (v: Cell) =>
  xmlSafe(v)
    .slice(0, MAX_CELL_CHARS)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

// 0 -> A, 25 -> Z, 26 -> AA ...
export function columnRef(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function cellXml(ref: string, value: Cell, style?: number): string {
  const s = style ? ` s="${style}"` : "";
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"${s}><v>${value}</v></c>`;
  const text = esc(value ?? "");
  return text === "" ? "" : `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
}

function sheetXml(headers: string[], rows: Cell[][], opts: { freezeHeader: boolean; widths: number[] }): string {
  const lastCol = columnRef(Math.max(0, headers.length - 1));
  const head = `<row r="1">${headers.map((h, c) => cellXml(`${columnRef(c)}1`, h, 1)).join("")}</row>`;
  const body = rows.map((r, i) => `<row r="${i + 2}">${r.map((v, c) => cellXml(`${columnRef(c)}${i + 2}`, v)).join("")}</row>`).join("");
  const cols = `<cols>${opts.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`;
  const pane = opts.freezeHeader ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : "";
  const filter = opts.freezeHeader && headers.length ? `<autoFilter ref="A1:${lastCol}${Math.max(1, rows.length + 1)}"/>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}${cols}<sheetData>${head}${body}</sheetData>${filter}</worksheet>`;
}

// Column widths follow content (header or the longest of the first rows), within sensible bounds.
function widths(headers: string[], rows: Cell[][]): number[] {
  const sample = rows.slice(0, 300);
  return headers.map((h, i) => Math.max(10, Math.min(60, Math.max(h.length + 2, ...sample.map((r) => String(r[i] ?? "").length + 2)))));
}

// ---- ZIP container --------------------------------------------------------------------------------------------------
function zip(files: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const deflated = deflateRawSync(f.data);
    const crc = crc32(f.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0x00210000, 10); // fixed DOS time/date (1980-01-01): reproducible output
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, deflated);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(0x00210000, 12);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(deflated.length, 20);
    c.writeUInt32LE(f.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += local.length + name.length + deflated.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, end]);
}

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const REL = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

export interface WorkbookSheet {
  // Excel limits: at most 31 characters, none of : \ / ? * [ ]
  name: string;
  headers: string[];
  rows: Cell[][];
  // true = frozen, filterable header row with widths that follow content; false = fixed widths (a two-column details sheet).
  table: boolean;
  widths?: number[];
}

const safeSheetName = (n: string) => n.replace(/[:\\/?*[\]]/g, " ").slice(0, 31) || "Sheet";

// Any number of sheets. Every sheet uses its first row as a header.
export function buildWorkbook(sheets: WorkbookSheet[]): Buffer {
  const overrides = sheets
    .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join("");
  const sheetEls = sheets.map((sh, i) => `<sheet name="${esc(safeSheetName(sh.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");
  const rels =
    sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
  const files = [
    {
      name: "[Content_Types].xml",
      data: `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      data: `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    { name: "xl/workbook.xml", data: `${HEAD}<workbook ${NS} ${REL}><sheets>${sheetEls}</sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>` },
    {
      name: "xl/styles.xml",
      data: `${HEAD}<styleSheet ${NS}><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`,
    },
    ...sheets.map((sh, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: sheetXml(sh.headers, sh.rows, { freezeHeader: sh.table, widths: sh.widths ?? widths(sh.headers, sh.rows) }),
    })),
  ];
  return zip(files.map((f) => ({ name: f.name, data: Buffer.from(f.data, "utf8") })));
}

export function buildXlsx(meta: ReportDocMeta, headers: string[], rows: Cell[][]): Buffer {
  const details: Cell[][] = [
    ["Report", meta.title],
    ...(meta.description ? [["Description", meta.description] as Cell[]] : []),
    ["Matching companies", meta.total],
    ...(meta.conditions ? [["Conditions", meta.conditions] as Cell[]] : []),
    ...(meta.sortLabel ? [["Sorted by", meta.sortLabel] as Cell[]] : []),
    ["Generated (UTC)", meta.generatedAt.toISOString().replace("T", " ").slice(0, 16)],
    ["Source", "DIRECTOR.LTD (Companies House data)"],
  ];
  // The details sheet uses its first row as a header too: "Field" / "Value".
  return buildWorkbook([
    { name: "Companies", headers, rows, table: true },
    { name: "Report details", headers: ["Field", "Value"], rows: details, table: false, widths: [22, 90] },
  ]);
}
