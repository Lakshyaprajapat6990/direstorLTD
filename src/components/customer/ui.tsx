import Link from "next/link";
import { ArrowRight, Building2, CheckCircle2, ChevronRight, Users, XCircle } from "lucide-react";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/Badge";
import { STATUS_LABELS, STATUS_TONE, typeLabel } from "@/lib/data/format";
import type { CompanyStatus } from "@/lib/types";
import type { PublicRegisterStats } from "@/lib/data/public-stats";
import type { FreeSearchRow } from "@/lib/customer/free-tier";

// Presentation shared by the free-customer pages. It reproduces the look of the staff Dashboard / UK Companies / company pages
// (same hero gradient, grid, circles, tiles and cards: the class strings are the same ones those pages use, and the section
// primitives come from components/companies/WorkspaceSection). It is plain server-safe markup with no data access, so both
// server pages and client components can use it. The staff pages themselves are not touched.

export function CustomerHero({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <header
      className={cn("relative overflow-hidden rounded-2xl bg-gradient-to-br from-indigo-950 via-indigo-900 to-indigo-700 px-6 py-8 text-white shadow-lg shadow-indigo-950/20 sm:px-10 sm:py-10", className)}
      style={{
        backgroundImage:
          "linear-gradient(rgba(255,255,255,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.045) 1px, transparent 1px), linear-gradient(135deg, var(--color-indigo-950), var(--color-indigo-900) 55%, var(--color-indigo-700))",
        backgroundSize: "36px 36px, 36px 36px, auto",
      }}
    >
      <svg aria-hidden className="pointer-events-none absolute -right-10 -top-16 hidden h-[26rem] w-[26rem] text-white/10 lg:block" viewBox="0 0 400 400" fill="none" stroke="currentColor" strokeWidth="1.2">
        <circle cx="200" cy="200" r="190" />
        <circle cx="200" cy="200" r="140" />
        <circle cx="200" cy="200" r="90" />
        <path d="M200 10v380M10 200h380M65 65l270 270M335 65L65 335" strokeOpacity=".5" />
        <g fill="currentColor" stroke="none">
          <circle cx="200" cy="10" r="5" />
          <circle cx="335" cy="65" r="5" />
          <circle cx="390" cy="200" r="5" />
          <circle cx="140" cy="200" r="4" />
          <circle cx="290" cy="290" r="4" />
        </g>
      </svg>
      <div className="relative">{children}</div>
    </header>
  );
}

export function HeroPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-indigo-100 ring-1 ring-white/15">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden /> {children}
    </span>
  );
}

export function HeroChips({ items }: { items: [string, string][] }) {
  return (
    <div className="mt-5 flex flex-wrap gap-2 text-xs">
      {items.map(([k, v]) => (
        <span key={k} className="rounded-md bg-white/10 px-3 py-1.5 text-indigo-200 ring-1 ring-white/10">
          {k}: <span className="font-semibold text-white">{v}</span>
        </span>
      ))}
    </div>
  );
}

// Same white search bar as the staff hero. `action` is the customer search page: never the staff /companies route.
export function HeroSearch({ q = "", minLength = 3 }: { q?: string; minLength?: number }) {
  return (
    <form action="/find-companies" method="get" className="flex w-full items-center gap-2 rounded-2xl bg-white p-2 pl-5 shadow-xl shadow-indigo-950/30 ring-4 ring-white/10 focus-within:ring-white/30">
      <Building2 className="h-5 w-5 shrink-0 text-slate-400" aria-hidden />
      <input
        name="q"
        defaultValue={q}
        minLength={minLength}
        maxLength={100}
        aria-label="Search UK companies by name or number"
        placeholder="Name or number…"
        className="min-w-0 flex-1 bg-transparent py-3 text-[15px] text-slate-900 outline-none placeholder:text-slate-400"
      />
      <button type="submit" aria-label="Search" className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-700 sm:px-5">
        <span className="hidden sm:inline">Search</span> <ArrowRight className="h-4 w-4" aria-hidden />
      </button>
    </form>
  );
}

const KPI = {
  blue: { tint: "from-indigo-50", chip: "bg-indigo-600", mark: "text-indigo-200/70", bar: "bg-indigo-500", track: "bg-indigo-100", text: "text-indigo-700" },
  green: { tint: "from-emerald-50", chip: "bg-emerald-600", mark: "text-emerald-200/70", bar: "bg-emerald-500", track: "bg-emerald-100", text: "text-emerald-700" },
  red: { tint: "from-red-50", chip: "bg-red-500", mark: "text-red-200/70", bar: "bg-red-500", track: "bg-red-100", text: "text-red-600" },
  violet: { tint: "from-violet-50", chip: "bg-violet-600", mark: "text-violet-200/70", bar: "bg-violet-500", track: "bg-violet-100", text: "text-violet-700" },
} as const;

// The four register tiles of the staff dashboard, from the same figures (getRegisterBreakdown via getPublicSiteStats).
export function RegisterTiles({ register }: { register: PublicRegisterStats }) {
  const share = (n: number) => (register.total > 0 ? (n / register.total) * 100 : 0);
  const shareLabel = (n: number) => {
    const p = share(n);
    return p === 0 ? "0%" : p < 0.01 ? "<0.01%" : p < 10 ? `${p.toFixed(2)}%` : `${p.toFixed(1)}%`;
  };
  // UK companies only; the share bars use the UK total as the denominator. The director tile has no share: it is how many companies'
  // officers have been fetched so far (crawl progress), which would read as missing data.
  const other = Math.max(0, register.total - register.active - register.dissolved);
  const tiles = [
    { label: "UK companies on the register", value: register.total, icon: Building2, kpi: "blue", share: false, note: `Includes ${other.toLocaleString("en-GB")} in other statuses` },
    { label: "Active", value: register.active, icon: CheckCircle2, kpi: "green", share: true, note: "" },
    { label: "Dissolved", value: register.dissolved, icon: XCircle, kpi: "red", share: true, note: "" },
    { label: "With confirmed director data", value: register.directorsConfirmed, icon: Users, kpi: "violet", share: false, note: "Officers fetched so far" },
  ] as const;
  return (
    <section aria-label="UK company register" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles.map(({ label, value, icon: Icon, kpi, share: showShare, note }) => {
        const c = KPI[kpi];
        return (
          <div key={label} className={`relative h-full overflow-hidden rounded-xl border border-slate-200 bg-gradient-to-br ${c.tint} to-white p-4 shadow-sm`}>
            <Icon aria-hidden className={`absolute -right-3 -top-3 h-20 w-20 ${c.mark}`} strokeWidth={1.25} />
            <div className="relative">
              <span className={`flex h-9 w-9 items-center justify-center rounded-xl text-white shadow-sm ${c.chip}`}>
                <Icon className="h-[18px] w-[18px]" aria-hidden />
              </span>
              <p className="mt-3 text-[28px] font-bold leading-none tabular-nums tracking-tight text-slate-900 sm:text-3xl">{value.toLocaleString("en-GB")}</p>
              <p className="mt-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</p>
              <div className="mt-3 flex items-center gap-2">
                {showShare ? (
                  <>
                    <span className={`h-1.5 flex-1 overflow-hidden rounded-full ${c.track}`} role="img" aria-label={`${shareLabel(value)} of UK companies`}>
                      <span className={`block h-full rounded-full ${c.bar}`} style={{ width: `${Math.max(share(value), share(value) > 0 ? 1.5 : 0)}%` }} />
                    </span>
                    <span className={`text-[11px] font-semibold tabular-nums ${c.text}`}>{shareLabel(value)}</span>
                  </>
                ) : (
                  <span className={`text-[11px] font-semibold ${c.text}`}>{note}</span>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </section>
  );
}

// One company per row: identity fields only. Links to the customer company page, which asks before spending a view.
export function CompanyRows({ rows }: { rows: FreeSearchRow[] }) {
  return (
    <ul className="divide-y divide-slate-100">
      {rows.map((r) => {
        const status = r.status as CompanyStatus;
        return (
          <li key={r.id}>
            <Link href={`/find-companies/${r.id}`} className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-slate-50 focus-ring">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
                <Building2 className="h-5 w-5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-slate-900 group-hover:text-indigo-700">{r.name}</span>
                <span className="block truncate text-xs text-slate-500">
                  <span className="font-mono">{r.companyNumber}</span> · {typeLabel(r.type)}
                </span>
              </span>
              <Badge tone={STATUS_TONE[status] ?? "slate"}>{STATUS_LABELS[status] ?? r.status}</Badge>
              <ChevronRight className="hidden h-4 w-4 shrink-0 text-slate-300 group-hover:text-indigo-500 sm:block" aria-hidden />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
