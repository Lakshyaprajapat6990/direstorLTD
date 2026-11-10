import { BrandDot } from "@/components/brand/BrandDot";
import { CheckCircle2, Eye, Lock, Search, Sparkles, XCircle } from "lucide-react";
import { FREE_SEARCH_RESULTS, type FreeSearchRow, type FreeUsage } from "@/lib/customer/free-tier";
import type { PublicSiteStats } from "@/lib/data/public-stats";
import { formatDate } from "@/lib/data/format";
import { SectionHeader, sectionCard } from "@/components/companies/WorkspaceSection";
import { LinkButton } from "@/components/ui/Button";
import { CompanyRows, CustomerHero, HeroChips, HeroPill, HeroSearch, RegisterTiles } from "./ui";

// The dashboard a free customer account sees: the same hero and register tiles as the staff Dashboard, then the customer's own
// allowance and a sample of real companies. Every statement mirrors what the server enforces (src/lib/customer/free-tier.ts and
// the empty permission list of the CUSTOMER role). Figures come only from the stats and usage passed in; nothing is typed here.
export function CustomerWelcome({ name, usage, stats, samples }: { name: string; usage: FreeUsage; stats: PublicSiteStats; samples: FreeSearchRow[] }) {
  const pct = Math.min(100, Math.round((usage.used / usage.limit) * 100));
  const dataAsOf = stats.state === "ok" ? stats.dataAsOf : null;
  return (
    <div className="w-full space-y-5">
      <CustomerHero>
        <div className="grid grid-cols-1 items-center gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <div className="min-w-0">
            <HeroPill>Free account</HeroPill>
            <h2 className="mt-4 text-4xl font-bold tracking-tight sm:text-5xl">Welcome to DIRECTOR<BrandDot />LTD</h2>
            <p className="mt-2 max-w-xl text-[15px] text-indigo-100">
              Hello {name.split(" ")[0]}. Your free DIRECTOR.LTD account is ready: search the UK company register and open basic details for {usage.limit} companies.
            </p>
            <HeroChips items={[["Source", "Companies House"], ["Registration ID", "Company number"], ["Last updated", dataAsOf ? formatDate(dataAsOf) : "—"]]} />
          </div>
          <HeroSearch />
        </div>
      </CustomerHero>

      {stats.state === "ok" && <RegisterTiles register={stats.register} />}

      <section className={`${sectionCard} overflow-hidden`} aria-labelledby="free-usage">
        <SectionHeader title="Your free company views" icon={Eye} source="none" />
        <div className="space-y-3 p-4">
          <h2 id="free-usage" className="sr-only">Your free company views</h2>
          <p className="text-sm text-slate-600">
            You have opened <strong>{usage.used}</strong> of <strong>{usage.limit}</strong> companies and have <strong>{usage.remaining}</strong> left. Searching is free, and reopening a company you have already opened does not use another view.
          </p>
          <div className="h-2 overflow-hidden rounded-full bg-indigo-100" role="progressbar" aria-valuemin={0} aria-valuemax={usage.limit} aria-valuenow={usage.used} aria-label="Free company views used">
            <div className="h-full rounded-full bg-indigo-600" style={{ width: `${pct}%` }} />
          </div>
          <LinkButton href="/find-companies">
            <Search className="h-4 w-4" aria-hidden="true" /> Find a company
          </LinkButton>
        </div>
      </section>

      <section className={`${sectionCard} overflow-hidden`} aria-label="Sample companies">
        <SectionHeader title="Sample companies to explore" icon={Sparkles} count={samples.length || undefined} source="companies-house" />
        {samples.length === 0 ? (
          <p className="px-4 py-5 text-[13px] text-slate-500">Sample companies are not available right now. Use the search above to find a company.</p>
        ) : (
          <>
            <CompanyRows rows={samples} />
            <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">Listing a company does not use a view. You choose to open it on the next page, and that uses one of your {usage.limit}.</p>
          </>
        )}
      </section>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <section className={`${sectionCard} overflow-hidden`} aria-labelledby="included">
          <SectionHeader title="Included in your free account" icon={CheckCircle2} source="none" />
          <h2 id="included" className="sr-only">Included in your free account</h2>
          <ul className="space-y-2 p-4 text-sm text-slate-700">
            {[`Search UK companies by name or company number (first ${FREE_SEARCH_RESULTS} matches)`, `Open ${usage.limit} different companies to see basic register details`, "Update your profile picture in Settings"].map((t) => (
              <li key={t} className="flex gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" /> {t}
              </li>
            ))}
          </ul>
        </section>
        <section className={`${sectionCard} overflow-hidden`} aria-labelledby="not-included">
          <SectionHeader title="Not available on a free account" icon={Lock} source="none" />
          <h2 id="not-included" className="sr-only">Not available on a free account</h2>
          <ul className="space-y-2 p-4 text-sm text-slate-700">
            {["Report Builder and saved reports", "Exports (CSV, PDF, Word)", "Advanced Search and filters", "Director and officer details", "Notes, follow-ups and the calendar"].map((t) => (
              <li key={t} className="flex gap-2">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" /> {t}
              </li>
            ))}
            <li className="pt-1 text-xs text-slate-500">Paid access is not available to order online yet.</li>
          </ul>
        </section>
      </div>
    </div>
  );
}
