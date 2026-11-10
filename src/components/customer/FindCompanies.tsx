"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Building2, Loader2, Search, Sparkles } from "lucide-react";
import { SectionHeader, sectionCard } from "@/components/companies/WorkspaceSection";
import type { FreeSearchRow, FreeUsage } from "@/lib/customer/free-tier";
import { CompanyRows, CustomerHero, HeroChips, HeroPill } from "./ui";

// The customer search page: the same hero as the staff UK Companies page, the same search bar, and the same company rows. It
// only ever calls /api/customer/companies/search (name or company number, first 10 matches, identity fields); there are no
// filters, pages or exports here, and nothing on this page can reach the staff search.
export function FindCompanies({ minChars, maxResults, usage, samples, initialQuery, notice }: { minChars: number; maxResults: number; usage: FreeUsage; samples: FreeSearchRow[]; initialQuery: string; notice?: string }) {
  const [q, setQ] = useState(initialQuery);
  const [rows, setRows] = useState<FreeSearchRow[] | null>(null);
  const [searched, setSearched] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);

  async function run(term: string) {
    if (busy.current) return;
    setError(null);
    if (term.trim().length < minChars) {
      setError(`Enter at least ${minChars} characters of a company name, or a company number.`);
      return;
    }
    busy.current = true;
    setLoading(true);
    try {
      const res = await fetch("/api/customer/companies/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: term }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data.error ?? "Something went wrong. Please try again.");
      else {
        setRows(data.rows);
        setSearched(term.trim());
      }
    } catch {
      setError("Could not reach the server. Please try again.");
    }
    busy.current = false;
    setLoading(false);
  }

  // A search sent from the dashboard (?q=...) runs once on arrival.
  useEffect(() => {
    if (initialQuery.trim().length < minChars) return;
    const t = setTimeout(() => void run(initialQuery), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    void run(q);
  }

  return (
    <div className="w-full space-y-5">
      <CustomerHero>
        <div className="grid grid-cols-1 items-center gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <div className="min-w-0">
            <HeroPill>United Kingdom company database</HeroPill>
            <h2 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">Find a company</h2>
            <p className="mt-2 max-w-2xl text-[15px] text-indigo-100">
              Search the Companies House register by company name or company number. Searching is free. Opening a company to see its details uses one of your {usage.limit} free views.
            </p>
            {notice && (
              <p role="status" className="mt-3 max-w-2xl rounded-lg bg-white/10 px-3 py-2 text-sm text-sky-100 ring-1 ring-white/20">
                {notice}
              </p>
            )}
            <HeroChips items={[["Opened", `${usage.used} of ${usage.limit}`], ["Views left", String(usage.remaining)]]} />
          </div>
          <div className="min-w-0 space-y-4">
          <form onSubmit={submit} noValidate className="flex w-full items-center gap-2 rounded-2xl bg-white p-2 pl-5 shadow-xl shadow-indigo-950/30 ring-4 ring-white/10 focus-within:ring-white/30">
            <Building2 className="h-5 w-5 shrink-0 text-slate-400" aria-hidden />
            <label htmlFor="find-q" className="sr-only">Company name or number</label>
            <input
              id="find-q"
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              maxLength={100}
              placeholder="Name or company number…"
              disabled={loading}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "find-error" : undefined}
              className="min-w-0 flex-1 bg-transparent py-3 text-[15px] text-slate-900 outline-none placeholder:text-slate-400"
            />
            <button type="submit" disabled={loading} className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-70 sm:px-5">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Search className="h-4 w-4 sm:hidden" aria-hidden />}
              <span className="hidden sm:inline">Search</span>
              <ArrowRight className="hidden h-4 w-4 sm:block" aria-hidden />
            </button>
          </form>
          {error && (
            <p id="find-error" role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}
          </div>
        </div>
      </CustomerHero>

      {rows ? (
        <section className={`${sectionCard} overflow-hidden`} aria-live="polite" aria-label="Search results">
          <SectionHeader title={`Results for “${searched}”`} icon={Search} count={rows.length} source="companies-house" />
          {rows.length === 0 ? (
            <p className="px-4 py-6 text-[13px] text-slate-500">No companies found. Try another spelling, or the company number.</p>
          ) : (
            <>
              <CompanyRows rows={rows} />
              <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
                {rows.length === maxResults ? `Showing the first ${maxResults} matches. Refine your search to narrow them down. ` : ""}Searching is free. Opening a company uses one of your free views.
              </p>
            </>
          )}
        </section>
      ) : (
        <section className={`${sectionCard} overflow-hidden`} aria-label="Sample companies">
          <SectionHeader title="Sample companies to explore" icon={Sparkles} count={samples.length || undefined} source="companies-house" />
          {samples.length === 0 ? (
            <p className="px-4 py-6 text-[13px] text-slate-500">Enter a company name or number above to get started.</p>
          ) : (
            <>
              <CompanyRows rows={samples} />
              <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">These are examples from the register. Listing a company does not use a view.</p>
            </>
          )}
        </section>
      )}
    </div>
  );
}
