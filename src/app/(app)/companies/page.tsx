import type { Metadata } from "next";
import { CompanyExplorer } from "@/components/companies/CompanyExplorer";
import { countRealCompanies } from "@/lib/data/companies";
import { getDataFreshness } from "@/lib/data/freshness";
import { requirePermission } from "@/lib/auth/guard";
import { buildHomeFilter, parseHomeSearch } from "@/lib/home-search";
import { loadUserColumns } from "@/lib/columns/store";

export const metadata: Metadata = { title: "UK Companies" };

export default async function CompaniesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  // The homepage search (and a bookmarked link) arrives as ?mode=&q=&type=&sic=&filing=&directors=. Untrusted values are validated and
  // dropped when unknown (lib/home-search.ts); a plain ?q= from the dashboard behaves exactly as before.
  const search = parseHomeSearch(params);
  const initialQuery = search.q;
  const hasCriteria = Boolean(search.type || search.sic || search.filing || search.directors);
  const initialFilter = hasCriteria ? buildHomeFilter(search) : undefined;
  const session = await requirePermission("companies.view");
  // Header facts, all real: the register size (memoised for a minute) and when the company data was last synchronised
  // from Companies House (newest successful monthly file / new-registrations sync; see lib/data/freshness.ts).
  const [total, freshness, columnState] = await Promise.all([countRealCompanies(), getDataFreshness(), loadUserColumns(session.userId)]);
  const lastUpdated = freshness.lastUpdated ? freshness.lastUpdated.toISOString() : null;
  return <CompanyExplorer scope="all" meta={{ total, lastUpdated }} initialQuery={initialQuery} initialFilter={initialFilter} initialColumns={columnState.columns} columnsNotice={columnState.recommendedChanged} />;
}
