import { BrandDot } from "@/components/brand/BrandDot";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { BarChart3, Building2, CheckCircle2, FileText, MapPin, ShieldCheck } from "lucide-react";

// The two-panel frame shared by sign in, create account and password recovery: a branded panel on the left (about 52% of a desktop
// screen) and the form in a compact card on the right. Presentation only; no authentication logic lives here.
//
// The data preview is an ILLUSTRATION. Its companies are obviously fictional ("Example", "Sample", "Demo"), it shows no registration
// numbers or figures, its bars carry no values, and it is labelled "Illustrative preview" and hidden from assistive technology. It
// shows the kind of thing DIRECTOR.LTD presents (a register table with statuses, a profile card), not real or claimed data.

const GRADIENT: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(rgba(255,255,255,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.045) 1px, transparent 1px), linear-gradient(135deg, var(--color-indigo-950), var(--color-indigo-900) 55%, var(--color-indigo-700))",
  backgroundSize: "36px 36px, 36px 36px, auto",
};

function Rings({ className }: { className: string }) {
  return (
    <svg aria-hidden className={className} viewBox="0 0 400 400" fill="none" stroke="currentColor" strokeWidth="1.2">
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
  );
}

function Brand() {
  return (
    <Link href="/" className="inline-flex items-center gap-2.5 rounded-md focus-ring">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-500 text-sm font-bold text-white">DL</span>
      <span className="text-lg font-semibold tracking-tight text-white">DIRECTOR<BrandDot />LTD</span>
    </Link>
  );
}

const PILL = {
  active: "bg-emerald-400/20 text-emerald-200 ring-emerald-300/30",
  dissolved: "bg-red-400/20 text-red-200 ring-red-300/30",
  liquidation: "bg-amber-400/20 text-amber-200 ring-amber-300/30",
} as const;

const ROWS: { name: string; status: keyof typeof PILL; label: string; w: string }[] = [
  { name: "Example Trading Ltd", status: "active", label: "Active", w: "w-14" },
  { name: "Sample Works Ltd", status: "active", label: "Active", w: "w-10" },
  { name: "Demo Holdings plc", status: "liquidation", label: "Liquidation", w: "w-12" },
  { name: "Illustrative Services Ltd", status: "dissolved", label: "Dissolved", w: "w-9" },
  { name: "Placeholder Ventures Ltd", status: "active", label: "Active", w: "w-11" },
];
const BARS = ["h-5", "h-8", "h-6", "h-10", "h-7", "h-9", "h-4"];

function DataPreview() {
  return (
    <div aria-hidden className="relative mx-auto w-full max-w-[34rem] pb-10 [@media(max-height:780px)]:pb-0">
      <div className="origin-left rounded-2xl bg-slate-950/30 shadow-2xl shadow-indigo-950/50 ring-1 ring-white/20 backdrop-blur-sm [transform:perspective(1400px)_rotateY(-9deg)_rotateX(3deg)]">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-red-400/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/80" />
          <FileText className="ml-2 h-3.5 w-3.5 text-indigo-200" />
          <span className="text-[11px] text-indigo-100">UK company register</span>
          <span className="ml-auto rounded-full bg-sky-400/20 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-sky-200 ring-1 ring-sky-300/30">Illustrative preview</span>
        </div>
        <div className="px-4 pb-3 pt-2">
          <div className="grid grid-cols-[1.9fr_1fr_1fr] gap-3 pb-1.5 text-[9px] font-semibold uppercase tracking-wider text-indigo-300">
            <span>Company</span>
            <span>Number</span>
            <span>Status</span>
          </div>
          <ul className="divide-y divide-white/10">
            {ROWS.map((r) => (
              <li key={r.name} className="grid grid-cols-[1.9fr_1fr_1fr] items-center gap-3 py-2">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-blue-500/70 text-white">
                    <Building2 className="h-3 w-3" />
                  </span>
                  <span className="truncate text-[11px] font-medium text-white">{r.name}</span>
                </span>
                <span className={`h-1.5 rounded-full bg-white/25 ${r.w}`} />
                <span className={`inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[9px] font-semibold ring-1 ${PILL[r.status]}`}>{r.label}</span>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-end justify-between border-t border-white/10 pt-3 [@media(max-height:780px)]:hidden">
            <div>
              <p className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-wider text-indigo-300">
                <BarChart3 className="h-3 w-3" /> Incorporations by year
              </p>
              <div className="mt-2 flex items-end gap-1.5">
                {BARS.map((h, i) => (
                  <span key={i} className={`w-3.5 rounded-t bg-gradient-to-t from-blue-500 to-sky-300 ${h}`} />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="absolute bottom-0 right-0 w-56 rounded-xl [@media(max-height:780px)]:hidden bg-white p-3 text-slate-900 shadow-xl shadow-indigo-950/40 ring-1 ring-slate-200">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600 text-white">
            <Building2 className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[11px] font-semibold">Example Trading Ltd</p>
            <span className="inline-flex items-center gap-1 text-[9px] font-semibold text-emerald-700">
              <CheckCircle2 className="h-2.5 w-2.5" /> Active
            </span>
          </div>
        </div>
        <div className="mt-2.5 space-y-1.5 text-[9px] text-slate-500">
          <p className="flex items-center gap-1.5">
            <ShieldCheck className="h-3 w-3 text-indigo-500" /> Company type
            <span className="ml-auto h-1.5 w-12 rounded-full bg-slate-200" />
          </p>
          <p className="flex items-center gap-1.5">
            <MapPin className="h-3 w-3 text-indigo-500" /> Registered address
            <span className="ml-auto h-1.5 w-16 rounded-full bg-slate-200" />
          </p>
        </div>
      </div>
    </div>
  );
}

export function AuthShell({
  headline,
  mobileHeadline,
  intro,
  points,
  children,
}: {
  headline: React.ReactNode;
  mobileHeadline: React.ReactNode;
  intro: string;
  points: { icon: LucideIcon; text: string }[];
  children: React.ReactNode;
}) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[52fr_48fr]">
      <aside className="relative hidden flex-col overflow-hidden px-10 py-8 text-white lg:flex xl:px-14" style={GRADIENT}>
        <Rings className="pointer-events-none absolute -right-28 -top-28 h-[36rem] w-[36rem] text-white/10" />
        <Rings className="pointer-events-none absolute -bottom-40 -left-32 h-[26rem] w-[26rem] text-white/[0.07]" />
        <div className="relative">
          <Brand />
        </div>

        <div className="relative my-auto w-full max-w-[34rem] py-8 xl:mx-auto">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-indigo-100 ring-1 ring-white/15">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden /> UK company data from Companies House
          </span>
          <h2 className="mt-4 text-3xl font-bold leading-[1.12] tracking-tight xl:text-[2.6rem]">{headline}</h2>
          <p className="mt-3 max-w-[30rem] text-sm leading-relaxed text-indigo-100">{intro}</p>
          <ul className="mt-5 hidden gap-y-2 text-[13px] text-indigo-50 [@media(min-height:880px)]:grid">
            {points.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-2.5">
                <Icon className="h-4 w-4 shrink-0 text-sky-300" aria-hidden />
                {text}
              </li>
            ))}
          </ul>
          <div className="mt-7">
            <DataPreview />
          </div>
        </div>

        <p className="relative text-xs text-indigo-300">© {new Date().getFullYear()} DIRECTOR.LTD</p>
      </aside>

      <main className="flex flex-col bg-slate-50">
        <div className="relative overflow-hidden px-6 py-6 text-white lg:hidden" style={GRADIENT}>
          <Rings className="pointer-events-none absolute -right-16 -top-20 h-64 w-64 text-white/10" />
          <div className="relative">
            <Brand />
            <p className="mt-3 text-xl font-bold leading-snug tracking-tight">{mobileHeadline}</p>
          </div>
        </div>
        <div className="flex flex-1 flex-col items-center justify-start px-4 py-6 sm:px-6 lg:justify-center lg:py-10">
          <div className="w-full max-w-[27rem] rounded-2xl bg-white p-6 shadow-xl shadow-slate-900/[0.06] ring-1 ring-slate-200 sm:p-8">{children}</div>
          {/* Signing in sets the strictly necessary session cookie, so the people using these pages can always read what is stored. No optional technology is used here, hence a link and no banner. */}
          <p className="mt-4 text-center text-xs text-slate-500">
            <Link href="/cookie-policy" className="font-medium text-indigo-600 underline underline-offset-2 hover:text-indigo-700 focus-ring">
              Cookie policy
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
