import { db } from "@/lib/db";
import { makeLogger } from "@/lib/log";
import { DEFAULT_SITE_CONTENT, type SiteContent } from "./defaults";
import { CURRENT_SCHEMA_VERSION, applyEditable, parseEditableContent } from "./schema";

// What the PUBLIC homepage renders. Always a complete, valid SiteContent:
//   - no row, never published, table missing, database unreachable, stored content invalid, or stored with another
//     schema version  ->  the built-in defaults (the permanent, reliable fallback);
//   - otherwise the stored published content, validated again here with the same strict schema, laid over the built-ins so
//     link destinations and every code-controlled piece (statistics, protected FAQ, API and ownership statements) can never
//     come from the database.
// Only the published columns are ever selected: a draft cannot reach the public page, whatever it contains.
// There is deliberately no in-memory cache: freshness is the page's own `revalidate` window plus revalidatePath on publish.

const log = makeLogger("site-content");

export interface PublishedRow {
  publishedJson: unknown;
  publishedVersion: number;
  schemaVersion: number;
}

export type ResolvedContent = { content: SiteContent; source: "defaults" | "published"; version: number; reason?: string };

// Pure: decides what to render from whatever the database returned.
export function resolvePublishedContent(row: PublishedRow | null): ResolvedContent {
  const fallback = (reason: string): ResolvedContent => ({ content: DEFAULT_SITE_CONTENT, source: "defaults", version: 0, reason });
  if (!row) return fallback("no content row");
  if (row.publishedJson == null || row.publishedVersion < 1) return fallback("never published");
  if (row.schemaVersion !== CURRENT_SCHEMA_VERSION) return fallback(`stored schema version ${row.schemaVersion} is not ${CURRENT_SCHEMA_VERSION}`);
  const parsed = parseEditableContent(row.publishedJson);
  if (!parsed.ok) return fallback(`stored content invalid: ${parsed.issues.slice(0, 3).map((i) => `${i.path || "(root)"}: ${i.message}`).join("; ")}`);
  return { content: applyEditable(DEFAULT_SITE_CONTENT, parsed.content), source: "published", version: row.publishedVersion };
}

export interface ReaderDeps {
  fetchRow: (key: string) => Promise<PublishedRow | null>;
}

export function createPublishedContentReader(deps: ReaderDeps) {
  return async function getResolved(key = "home"): Promise<ResolvedContent> {
    let row: PublishedRow | null;
    try {
      row = await deps.fetchRow(key);
    } catch (err) {
      // Missing table (migration not applied yet), connection failure, anything: the page must still render.
      log.error("published site content unavailable; using built-in content", { error: err instanceof Error ? err.message.split("\n").filter(Boolean).slice(-1)[0] : String(err) });
      return { content: DEFAULT_SITE_CONTENT, source: "defaults", version: 0, reason: "database error" };
    }
    const resolved = resolvePublishedContent(row);
    if (resolved.source === "defaults" && row && resolved.reason !== "never published") log.error("stored site content ignored; using built-in content", { key, reason: resolved.reason });
    return resolved;
  };
}

const getResolved = createPublishedContentReader({
  fetchRow: (key) => db.siteContent.findUnique({ where: { key }, select: { publishedJson: true, publishedVersion: true, schemaVersion: true } }),
});

export async function getPublishedSiteContent(key = "home"): Promise<SiteContent> {
  return (await getResolved(key)).content;
}

export { getResolved as getPublishedSiteContentResolved };
