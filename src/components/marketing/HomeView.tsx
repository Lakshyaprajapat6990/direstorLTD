import Link from "next/link";
import {
  ArrowRight,
  Building2,
  FileSpreadsheet,
  Star,
  Calendar,
  Flag,
  Bookmark,
  Search,
  ListChecks,
  Eye,
  Landmark,
  Layers,
  ShieldCheck,
  RefreshCw,
} from "lucide-react";
import { Fragment, type CSSProperties, type ReactNode } from "react";
import { LinkButton } from "@/components/ui/Button";
import { MarketingHeader } from "@/components/marketing/Header";
import { MarketingFooter } from "@/components/marketing/Footer";
import { SearchShowcase, WorkflowShowcase } from "@/components/marketing/LandingTabs";
import { CorporateStructure } from "./CorporateStructure";
import { CountUp } from "@/components/marketing/CountUp";
import { CustomSectionView } from "@/components/marketing/CustomSections";
import { RichP } from "@/components/marketing/RichText";
import { E, LOCK, editEd, editLock, noEd, noLock, type Ed, type EdAttrs } from "@/components/marketing/cms-edit";
import { mediaSrc } from "@/lib/site-content/sections";
import type { PublicSiteStats } from "@/lib/data/public-stats";
import type { StructureCompany } from "@/lib/data/structure-company";
import { formatDate } from "@/lib/data/format";
import { COMPANY_FILTER_FIELDS } from "@/lib/filters/fields";
import type { SiteContent } from "@/lib/site-content/defaults";
import { composeFaqRows } from "@/lib/site-content/protected-claims";
import { cycle, splitWords } from "@/lib/site-content/helpers";
import {
  BUTTONS,
  buttonDestination,
  buttonStyleFor,
  headingCss,
  partCss,
  statCardCss,
  cardLook,
  type CardKey,
  STAT_LABEL_DEFAULTS,
  type StatLabelKey,
  isCustomKey,
  resolveOrder,
  rowStyle,
  sectionCss,
  stripOverridden,
  type BuiltinKey,
  type ButtonKey,
  type ContentStyles,
  type HeadingKey,
  type RowKey,
} from "@/lib/site-content/styles";

// Icons and destinations are structure; the words come from the site content (same order).
const PLATFORM_CARD_LINKS: { icon: typeof Search; href: string }[] = [
  { icon: Building2, href: "/companies" },
  { icon: ListChecks, href: "/reports/new" },
  { icon: FileSpreadsheet, href: "/reports" },
  { icon: Eye, href: "/watches" },
  { icon: Bookmark, href: "/saved" },
  { icon: Flag, href: "/red-flags" },
  { icon: Calendar, href: "/calendar" },
  { icon: Star, href: "/companies" },
];
// A card beyond the known destinations still gets a safe one: everyone can sign in.
const PLATFORM_CARD_FALLBACK = { icon: Layers, href: "/login" };

const APART_ICONS = [ShieldCheck, RefreshCw, Search, Layers] as const;

// Colour treatment per use-case card (same order as the content).
const USE_CASE_TONES = ["from-indigo-900 to-indigo-700", "from-indigo-700 to-indigo-500", "from-indigo-950 to-indigo-800"] as const;

// A button of the homepage: label, look and (where the code allows it) destination come from the content's button settings. With no
// settings the output is exactly the built-in button. `strip` lists utility classes that use !important (they would defeat an
// inline colour), removed only for the property the editor has actually overridden.
function SiteButton({ id, st, variant, className, strip, children }: { id: ButtonKey; st: ContentStyles; variant?: "primary" | "outline"; className?: string; strip?: Parameters<typeof stripOverridden>[2]; children: ReactNode }) {
  const settings = st.buttons?.[id];
  const dest = buttonDestination(id, settings);
  const css = buttonStyleFor(id, settings);
  return (
    <LinkButton href={dest.href} variant={variant} size="lg" className={stripOverridden(className, css, strip)} style={css} newTab={dest.newTab}>
      {children}
    </LinkButton>
  );
}

function Eyebrow({ children, light, attrs }: { children: React.ReactNode; light?: boolean; attrs?: EdAttrs }) {
  return (
    <p className={`text-[13px] font-semibold uppercase tracking-[0.16em] ${light ? "text-blue-300" : "text-indigo-600"}`} {...attrs}>
      {children}
    </p>
  );
}

// Staggered word-by-word entrance for the hero heading. Words stay in one <h1> in reading order; the spans are plain inline-blocks.
function HeroWords({ words, start }: { words: string[]; start: number }) {
  return words.map((w, i) => (
    <span key={`${start}-${i}`}>
      <span className="hero-word" style={{ "--i": start + i } as React.CSSProperties}>{w}</span>{" "}
    </span>
  ));
}

type Edm = (path: string, extra?: CSSProperties) => EdAttrs;

// One figure card. The figure is live data (never editable text); the caption below it is editable and the card's look can be set.
// fit: the figure always stays on ONE line: globals.css ([data-fit-stat]) sizes it by the width of its own card (a container query), from the
// normal size down to a readable minimum, instead of letting the last digit wrap. Used for ALL the company-count figures (total, active,
// dissolved, directors) so they always share exactly the same size: the cards in the grid have equal width, so the same rule gives the same size.
function Stat({ value, labelKey, label, valueClassName = "text-2xl sm:text-3xl", count = true, fit = false, edm, sc }: { value: string; labelKey: StatLabelKey; label: string; valueClassName?: string; count?: boolean; fit?: boolean; edm: Edm; sc: ReturnType<typeof statCardCss> }) {
  return (
    <div className="min-w-0 rounded-xl border border-slate-200 bg-white px-4 py-4" data-fit-stat={fit ? "" : undefined} {...edm(`card:stat.${labelKey}`, sc.card)}>
      <p className={`break-words font-bold tabular-nums text-indigo-900 ${valueClassName}`} {...edm(`card:stat.${labelKey}`, sc.value)}>{count ? <CountUp value={value} /> : value}</p>
      <p className="mt-1 text-sm text-slate-500" {...edm(`ukRegister.labels.${labelKey}`, sc.label)}>{label}</p>
    </div>
  );
}

// The whole public homepage as a function of its content and the database-derived figures. Used by the public route
// (published content), by the Super Admin draft preview and by the visual editor's canvas (draft content). With `editing`
// off (every public use) nothing is added to the markup; with it on, elements carry data-cms paths so the editor can map a
// click to the field behind it, and code-controlled elements carry data-cms-locked so it can say why they cannot be edited.
export function HomeView({ content: c, stats, structure = null, editing = false }: { content: SiteContent; stats: PublicSiteStats; structure?: StructureCompany | null; editing?: boolean }) {
  const texts = c.styles?.texts ?? {};
  // Marks elements for the editor (editing only) and applies the validated look an editor gave a plain-text element, by its path.
  const withLook = (path: string, key: string, extra?: CSSProperties): EdAttrs => {
    const base: EdAttrs = editing ? editEd(path) : noEd(path);
    const css = texts[key] ? headingCss(texts[key]) : undefined;
    const style = css || extra ? { ...extra, ...css } : undefined;
    return style ? { ...base, style } : base;
  };
  const ed: Ed = (path) => withLook(path, path);
  const edm: Edm = (path, extra) => withLook(path, path, extra);
  const edCustom = (id: string, index: number): Ed => (path) => withLook(path, path.startsWith(`custom.${index}`) ? `custom:${id}${path.slice(`custom.${index}`.length)}` : path);
  const lock = editing ? editLock : noLock;
  const faq = composeFaqRows(c.faq.items);
  const leadWords = splitWords(c.hero.heading.lead);
  const custom = c.custom ?? [];
  const st: ContentStyles = c.styles ?? {};
  const order = resolveOrder(c.order, custom);
  // The "Built for" strip sits inside the hero while it is directly after it (as designed); moved elsewhere it is its own section.
  const stripInHero = order[1] === "builtFor";
  const hs = (k: HeadingKey): CSSProperties | undefined => headingCss(st.headings?.[k]);
  const accent = (k: HeadingKey): CSSProperties | undefined => partCss(st.headings?.[k], "accent");
  // The first part of a two-part heading is wrapped in a span only when it has a look of its own (otherwise the markup is unchanged).
  const leadPart = (k: HeadingKey, node: ReactNode): ReactNode => {
    const css = partCss(st.headings?.[k], "lead");
    return css ? <span style={css}>{node}</span> : node;
  };
  const scOf = (k: CardKey) => statCardCss(cardLook(st, k));
  const scr = scOf("register");
  // The register card has a gradient background: a chosen colour must replace it, so it goes in `background`.
  const regCard: CSSProperties | undefined = scr.card?.backgroundColor ? { ...scr.card, background: scr.card.backgroundColor, backgroundColor: undefined } : scr.card;
  const labels = c.ukRegister.labels ?? {};
  const circles = c.apart.circles;
  const circleImg = (i: number) => circles?.[String(i) as "0" | "1" | "2"];
  const L = (k: StatLabelKey) => labels[k] ?? STAT_LABEL_DEFAULTS[k];
  const row = (k: RowKey): CSSProperties | undefined => rowStyle(st.rows?.[k]?.align);
  // Section appearance. A chosen background replaces the section's own background (including gradients and dot pattern).
  const secStyle = (k: BuiltinKey, base?: CSSProperties): CSSProperties | undefined => {
    const css = sectionCss(st.sections?.[k]);
    if (css?.background) return css;
    return base || css ? { ...base, ...css } : undefined;
  };
  const r = stats.state === "ok" ? stats.register : null;
  // Never a made-up number: when the register figures are not available every figure is "—".
  const n = (v: number | undefined) => (v === undefined ? "—" : v.toLocaleString());
  const pct = (v: number) => (r && r.total > 0 ? (v / r.total) * 100 : 0);
  const dataAsOf = stats.state === "ok" && stats.dataAsOf ? formatDate(stats.dataAsOf) : "Unavailable";
  const figuresNotice =
    stats.state === "unavailable"
      ? "Live register figures are temporarily unavailable."
      : stats.state === "empty"
        ? "Register figures will appear once company data has been loaded."
        : null;
  const filterGroups = Object.entries(
    COMPANY_FILTER_FIELDS.reduce<Record<string, string[]>>((acc, f) => {
      (acc[f.group] ??= []).push(f.label);
      return acc;
    }, {})
  );

  const builtForStrip = (cls: string) => (
    <div className={cls}>
      <p className="text-xs font-semibold uppercase tracking-[0.25em] text-slate-500" {...ed("builtFor.label")}>{c.builtFor.label}</p>
      {/* Marquee: two identical sets in one track, shifted by exactly one set so the loop is seamless. The second set is
          hidden from assistive tech; with reduced motion (or no CSS animation) only the first set shows, as a static wrapped row. */}
      <div className="marquee mt-4">
        <div className="marquee-inner">
          <ul className="marquee-set" aria-label={c.builtFor.label}>
            {c.builtFor.audiences.map((a, i) => (
              <li key={`${i}-${a}`} {...ed(`builtFor.audiences.${i}`)}>{a}</li>
            ))}
          </ul>
          <ul className="marquee-set marquee-dup" aria-hidden>
            {c.builtFor.audiences.map((a, i) => (
              <li key={`${i}-${a}`} style={ed(`builtFor.audiences.${i}`).style}>{a}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );

  const parts: Record<BuiltinKey, ReactNode> = {
    builtFor: stripInHero ? null : (
      <section className="border-b border-slate-100" style={secStyle("builtFor")} {...ed("section:builtFor")}>
        {builtForStrip("mx-auto max-w-5xl px-6 py-10 text-center sm:py-12")}
      </section>
    ),
    // 1. Hero
    hero: (
      <section className="border-b border-slate-100" style={secStyle("hero", { backgroundImage: "radial-gradient(circle, #d6e2fb 1px, transparent 1px)", backgroundSize: "24px 24px" })} {...ed("section:hero")}>
        <div className="mx-auto max-w-6xl px-6 pb-10 pt-8 text-center sm:pb-12 sm:pt-10 lg:pt-12">
          <h1 className="mx-auto max-w-5xl text-balance text-[2.25rem] font-extrabold leading-[1.1] tracking-tight text-indigo-900 min-[400px]:text-[2.5rem] sm:text-5xl lg:text-6xl xl:text-[4.25rem] xl:leading-[1.06]" style={hs("hero.heading")} {...ed("hero.heading")}>
            {leadPart("hero.heading", <HeroWords words={leadWords} start={0} />)}
            <span className="text-indigo-600" style={accent("hero.heading")}><HeroWords words={splitWords(c.hero.heading.accent)} start={leadWords.length} /></span>
          </h1>
          <RichP value={c.hero.intro} attrs={ed("hero.intro")} className="motion-fade-up mx-auto mt-5 [animation-delay:420ms] max-w-2xl text-base leading-relaxed text-slate-500 sm:mt-6 sm:text-lg" />
          <div className="motion-fade-up mt-6 flex flex-col items-center justify-center gap-3 [animation-delay:520ms] sm:mt-8 sm:flex-row" style={row("hero.buttons")}>
            <SiteButton id="hero.primary" st={st} className="rounded-md px-8 py-4 text-base">
              <E ed={ed} path="hero.primaryCtaLabel">{c.hero.primaryCtaLabel}</E>
            </SiteButton>
            <SiteButton id="hero.secondary" st={st} variant="outline" className="rounded-md border-2 border-indigo-600 px-8 py-4 text-base text-indigo-600">
              <E ed={ed} path="hero.secondaryCtaLabel">{c.hero.secondaryCtaLabel}</E>
            </SiteButton>
          </div>
          <div className="motion-fade-up mt-5 flex flex-col items-center gap-2 [animation-delay:560ms]" {...lock(LOCK.structure)}>
            <LinkButton href="/register" size="lg" className="w-full max-w-xs rounded-md px-8 py-4 text-base shadow-md sm:w-auto sm:max-w-none">
              Create Your Free Account
            </LinkButton>
            <p className="text-sm text-slate-500">Free to join. No payment details needed.</p>
          </div>
        </div>
        {stripInHero && builtForStrip("mx-auto max-w-5xl px-6 pb-10 text-center sm:pb-12")}
      </section>

    
    ),
    // 2. UK register at a glance
    register: (
      <section id="uk-data" className="py-24" style={secStyle("register")} {...ed("section:register")}>
        <div className="mx-auto grid max-w-7xl items-center gap-14 px-6 lg:grid-cols-2">
          <div className="min-w-0">
            <Eyebrow attrs={ed("ukRegister.eyebrow")}>{c.ukRegister.eyebrow}</Eyebrow>
            <h2 className="mt-4 text-5xl font-extrabold leading-tight tracking-tight text-indigo-900" style={hs("ukRegister.heading")} {...ed("ukRegister.heading")}>
              {leadPart("ukRegister.heading", `${c.ukRegister.heading.lead} `)}<span className="text-indigo-600" style={accent("ukRegister.heading")}>{c.ukRegister.heading.accent}</span>
            </h2>
            <RichP value={c.ukRegister.intro} attrs={ed("ukRegister.intro")} className="mt-5 text-lg leading-relaxed text-slate-500" />
            <div className="mt-8 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3" {...lock(LOCK.stats)}>
              <Stat value={n(r?.total)} labelKey="total" label={L("total")} fit edm={edm} sc={scOf("total")} />
                <Stat value={n(r?.active)} labelKey="active" label={L("active")} fit edm={edm} sc={scOf("active")} />
                <Stat value={n(r?.dissolved)} labelKey="dissolved" label={L("dissolved")} fit edm={edm} sc={scOf("dissolved")} />
                <Stat value={n(r?.directorsConfirmed)} labelKey="directors" label={L("directors")} fit edm={edm} sc={scOf("directors")} />
                <Stat value={String(COMPANY_FILTER_FIELDS.length)} labelKey="filters" label={L("filters")} edm={edm} sc={scOf("filters")} />
                <Stat value={dataAsOf} labelKey="sync" label={L("sync")} valueClassName="text-xl sm:text-2xl" count={false} edm={edm} sc={scOf("sync")} />
            </div>
            <p className="mt-4 text-sm leading-relaxed text-slate-500" {...lock(LOCK.notes)}>
              {figuresNotice ?? "Figures are counted from the DIRECTOR.LTD database and refreshed every few minutes."} “Last data sync” is when the most recent Companies House synchronisation run finished; it does not mean every record was updated on that date, and the loaded companies may not include every company on the Companies House register.
            </p>
          </div>
          <div className="min-w-0 rounded-3xl border border-slate-200 bg-gradient-to-br from-indigo-50 to-white p-8 shadow-xl shadow-blue-100/60" style={regCard} {...lock(LOCK.stats)} {...ed("card:register")}>
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-600 text-white">
                <Landmark className="h-5 w-5" />
              </span>
              <div>
                <p className="text-lg font-bold text-indigo-900" {...ed("ukRegister.labels.cardTitle")}>{L("cardTitle")}</p>
                <p className="text-sm text-slate-500" {...ed("ukRegister.labels.cardSub")}>{L("cardSub")}</p>
              </div>
            </div>
            <p className="mt-8 text-4xl font-extrabold tabular-nums tracking-tight text-indigo-900 min-[375px]:text-5xl sm:text-6xl" style={scr.value} {...ed("card:register")}><CountUp value={n(r?.total)} /></p>
            <p className="text-slate-500" {...edm("ukRegister.labels.cardCaption", scr.label)}>{L("cardCaption")}</p>
            <div className="mt-6 flex h-4 overflow-hidden rounded-full bg-slate-200" role="img" aria-label={r ? "Share of companies by status" : "Share of companies by status: not available"}>
              <div className="bg-indigo-600" style={{ width: `${pct(r?.active ?? 0)}%` }} />
              <div className="bg-indigo-300" style={{ width: `${pct(r?.dissolved ?? 0)}%` }} />
              <div className="bg-slate-400" style={{ width: `${pct(r?.other ?? 0)}%` }} />
            </div>
            <ul className="mt-4 space-y-2 text-sm text-slate-600">
              <li className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-indigo-600" /> Active · {n(r?.active)}</li>
              <li className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-indigo-300" /> Dissolved · {n(r?.dissolved)}</li>
              <li className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-slate-400" /> Other statuses (liquidation, administration…) · {n(r?.other)}</li>
            </ul>
          </div>
        </div>
      </section>

    
    ),
    // 3. Compliant / source card
    source: (
      <section className="bg-slate-50/70 pb-24 pt-4" style={secStyle("source")} {...ed("section:source")}>
        <div className="mx-auto max-w-6xl px-6">
          <div className="relative overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
            <div className="absolute inset-x-0 top-0 mx-auto h-0.5 w-2/3 bg-gradient-to-r from-transparent via-indigo-500 to-transparent" />
            <div className="grid lg:grid-cols-2">
              <div className="p-10 lg:p-14">
                <Eyebrow attrs={ed("officialSource.eyebrow")}>{c.officialSource.eyebrow}</Eyebrow>
                <h2 className="mt-4 text-4xl font-bold leading-tight tracking-tight text-indigo-900" style={hs("officialSource.heading")} {...ed("officialSource.heading")}>{c.officialSource.heading}</h2>
                <RichP value={c.officialSource.text} attrs={ed("officialSource.text")} className="mt-5 text-lg leading-relaxed text-slate-500" />
                <SiteButton id="source.cta" st={st} className="mt-8 rounded-md">
                  <E ed={ed} path="officialSource.ctaLabel">{c.officialSource.ctaLabel}</E>
                </SiteButton>
              </div>
              <div className="border-t border-slate-100 bg-slate-50/50 p-10 lg:border-l lg:border-t-0 lg:p-14" {...lock(LOCK.stats)}>
                <p className="flex items-center gap-2 text-sm font-semibold text-indigo-900"><ShieldCheck className="h-4 w-4 text-indigo-600" /> United Kingdom</p>
                <p className="mt-3 text-4xl font-extrabold tabular-nums tracking-tight text-indigo-600 min-[375px]:text-5xl sm:text-6xl"><CountUp value={n(r?.total)} /></p>
                <p className="mt-1 text-sm text-slate-500">companies · Companies House</p>
                <div className="mt-8 border-t border-slate-200 pt-8">
                  <p className="text-4xl font-bold tabular-nums text-indigo-900">{n(r?.directorsConfirmed)}</p>
                  <p className="mt-1 text-sm text-slate-500">companies have confirmed director data so far. The rest show “Not fetched”, never zero.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

    
    ),
    // 4. Corporate structure (planned, honest)
    structure: (
      <section className="py-24" style={secStyle("structure")} {...ed("section:structure")} {...lock(LOCK.claim)}>
        <div className="mx-auto grid max-w-7xl items-center gap-14 px-6 lg:grid-cols-[1fr_1.2fr]">
          <div className="min-w-0">
            <Eyebrow>Ownership data · planned</Eyebrow>
            <h2 className="mt-4 text-5xl font-extrabold leading-tight tracking-tight text-indigo-900">Corporate structure</h2>
            <p className="mt-5 text-lg leading-relaxed text-slate-500">
              Parent companies, subsidiaries and beneficial ownership are not part of the data DIRECTOR.LTD holds today, so none is shown or implied. Each company record has a Corporate structure section that will light up if verified data is added.
            </p>
            <ul className="mt-6 space-y-2 text-[15px] text-slate-600">
              <li className="flex items-center gap-2"><span className="h-3 w-3 rounded-sm bg-indigo-900" /> Parent company · planned</li>
              <li className="flex items-center gap-2"><span className="h-3 w-3 rounded-sm bg-indigo-400" /> Subsidiaries · planned</li>
              <li className="flex items-center gap-2"><span className="h-3 w-3 rounded-sm bg-indigo-200" /> Beneficial owners · planned</li>
            </ul>
          </div>
          <CorporateStructure company={structure} />
        </div>
      </section>

    
    ),
    // 5. Search and datapoints
    search: (
      <section id="search" className="bg-indigo-50/70 py-24" style={secStyle("search")} {...ed("section:search")}>
        <div className="mx-auto max-w-7xl px-6">
          <div className="mx-auto max-w-3xl text-center">
            <Eyebrow attrs={ed("search.eyebrow")}>{c.search.eyebrow}</Eyebrow>
            <h2 className="mt-4 text-5xl font-extrabold tracking-tight text-indigo-900" style={hs("search.heading")} {...ed("search.heading")}>{c.search.heading}</h2>
            <p className="mt-4 text-lg text-slate-600" {...lock(LOCK.notes)}>One search box over every loaded company, then {COMPANY_FILTER_FIELDS.length} filter fields to narrow it down.</p>
          </div>
          <div className="mt-10">
            <SearchShowcase content={c.search.tabs} editing={editing} />
          </div>
          <p className="mt-6 text-center text-sm text-slate-600" {...lock(LOCK.notes)}>
            Source: <span className="text-indigo-600">Companies House</span> · <Link href="#filters" className="rounded-sm font-semibold text-indigo-600 hover:underline focus-ring">See all filter fields →</Link>
          </p>
          <div className="mx-auto mt-16 grid max-w-6xl grid-cols-2 gap-y-8 divide-slate-300 text-center md:grid-cols-5 md:divide-x" {...lock(LOCK.stats)}>
            {[
              [n(r?.total), "UK companies"],
              [n(r?.active), "Active companies"],
              [n(r?.directorsConfirmed), "Companies with confirmed directors"],
              [String(COMPANY_FILTER_FIELDS.length), "Filter fields"],
              ["DS01 · DS02", "Strike-off filings supported"],
            ].map(([v, l]) => (
              <div key={l} className="min-w-0 px-3 md:px-2 lg:px-3">
                <p className="text-xl font-extrabold tabular-nums tracking-tight text-indigo-900 min-[400px]:text-2xl lg:text-3xl xl:text-4xl"><CountUp value={v} /></p>
                <p className="mt-2 text-sm text-slate-600">{l}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

    
    ),
    // 6. Filters
    filters: (
      <section id="filters" className="py-24" style={secStyle("filters")} {...ed("section:filters")}>
        <div className="mx-auto max-w-7xl px-6">
          <div className="mx-auto max-w-3xl text-center">
            <Eyebrow attrs={ed("filters.eyebrow")}>{c.filters.eyebrow}</Eyebrow>
            <h2 className="mt-4 text-5xl font-extrabold tracking-tight text-indigo-900" style={hs("filters.heading")} {...ed("filters.heading")}>{c.filters.heading}</h2>
            <RichP value={c.filters.text} attrs={ed("filters.text")} className="mt-4 text-lg text-slate-500" />
          </div>
          <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-3" {...lock(LOCK.structure)}>
            {filterGroups.map(([group, fields]) => (
              <div key={group} className="rounded-2xl border border-slate-200 bg-white p-6 transition-shadow hover:shadow-md">
                <p className="text-lg font-bold text-indigo-900">{group}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {fields.map((f) => (
                    <span key={f} className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700">{f}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

    
    ),
    // 7. Workflow tabs
    workflow: (
      <section id="workflow" className="border-t border-slate-100 bg-slate-50/70 py-24" style={secStyle("workflow")} {...ed("section:workflow")}>
        <div className="mx-auto max-w-7xl px-6">
          <div className="mx-auto mb-10 max-w-3xl text-center">
            <Eyebrow attrs={ed("workflow.eyebrow")}>{c.workflow.eyebrow}</Eyebrow>
            <h2 className="mt-4 text-5xl font-extrabold tracking-tight text-indigo-900" style={hs("workflow.heading")} {...ed("workflow.heading")}>
              {leadPart("workflow.heading", `${c.workflow.heading.lead} `)}<span className="text-indigo-600" style={accent("workflow.heading")}>{c.workflow.heading.accent}</span>
            </h2>
            <RichP value={c.workflow.text} attrs={ed("workflow.text")} className="mt-4 text-lg text-slate-500" />
          </div>
          <WorkflowShowcase content={c.workflow} editing={editing} tryStyle={buttonStyleFor("workflow.try", st.buttons?.["workflow.try"])} />
        </div>
      </section>

    
    ),
    // 8. Platform cards
    platform: (
      <section className="py-24" style={secStyle("platform")} {...ed("section:platform")}>
        <div className="mx-auto max-w-7xl px-6">
          <div className="mx-auto max-w-3xl text-center">
            <Eyebrow attrs={ed("platform.eyebrow")}>{c.platform.eyebrow}</Eyebrow>
            <h2 className="mt-4 text-5xl font-extrabold tracking-tight text-indigo-900" style={hs("platform.heading")} {...ed("platform.heading")}>{c.platform.heading}</h2>
            <RichP value={c.platform.text} attrs={ed("platform.text")} className="mt-4 text-lg text-slate-500" />
          </div>
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {c.platform.cards.map(({ title, text }, i) => {
              const { icon: Icon, href } = PLATFORM_CARD_LINKS[i] ?? PLATFORM_CARD_FALLBACK;
              return (
              <Link key={`${i}-${title}`} href={href} className="group reveal rounded-xl border border-slate-200 bg-white p-6 transition-all hover:border-indigo-300 hover:shadow-md focus-ring">
                <Icon className="h-6 w-6 text-indigo-600" />
                <p className="mt-4 text-xl font-bold text-indigo-900" {...ed(`platform.cards.${i}.title`)}>{title}</p>
                <RichP value={text} attrs={ed(`platform.cards.${i}.text`)} className="mt-1 text-sm text-slate-500" />
                <span className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-indigo-600 transition-opacity [@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100">Open <ArrowRight className="h-3.5 w-3.5" /></span>
              </Link>
              );
            })}
          </div>
        </div>
      </section>

    
    ),
    // 9. What sets us apart
    apart: (
      <section className="border-t border-slate-100 bg-slate-50/70 py-24" style={secStyle("apart")} {...ed("section:apart")}>
        <div className="mx-auto grid max-w-7xl items-center gap-14 px-6 lg:grid-cols-2">
          <div className="flex min-w-0 flex-col items-center text-center">
            <div className="relative flex h-56 w-96 max-w-full items-center justify-center" aria-hidden={circles ? undefined : true}>
              {[0, 1, 2].map((i) => (
                <span key={i} className={`absolute h-32 w-32 rounded-full sm:h-44 sm:w-44 border-4 border-white bg-gradient-to-br from-indigo-100/70 to-white shadow-lg${circleImg(i) ? " overflow-hidden" : ""}`} style={{ left: `${i * 26 + 4}%` }} {...ed(`image:circle.${i}`)}>
                    {circleImg(i) && (
                      // eslint-disable-next-line @next/next/no-img-element -- served by our own /media route
                      <img src={mediaSrc(circleImg(i)!.mediaId)} alt={circleImg(i)!.alt} loading="lazy" decoding="async" className={`h-full w-full rounded-full ${circleImg(i)!.fit === "contain" ? "object-contain" : "object-cover"}`} />
                    )}
                  </span>
              ))}
            </div>
            <p className="mt-4 text-3xl font-bold text-indigo-900" style={hs("apart.talk.title")} {...ed("apart.talk.title")}>{c.apart.talk.title}</p>
            <RichP value={c.apart.talk.text} attrs={ed("apart.talk.text")} className="mt-2 max-w-sm text-slate-500" />
            <SiteButton id="apart.cta" st={st} className="mt-6 rounded-md"><E ed={ed} path="apart.talk.ctaLabel">{`${c.apart.talk.ctaLabel} `}</E><ArrowRight className="h-4 w-4" /></SiteButton>
          </div>
          <div className="min-w-0">
            <Eyebrow attrs={ed("apart.eyebrow")}>{c.apart.eyebrow}</Eyebrow>
            <h2 className="mt-4 text-4xl font-extrabold leading-tight tracking-tight text-indigo-900" style={hs("apart.heading")} {...ed("apart.heading")}>{c.apart.heading}</h2>
            <div className="mt-8 divide-y divide-slate-200 border-y border-slate-200">
              {c.apart.items.map(({ title: t, text: d }, i) => (
                <details key={`${i}-${t}`} className="group py-5" open={i === 0}>
                  <summary className="focus-ring flex cursor-pointer list-none items-center gap-4 text-lg font-bold text-indigo-900">
                    <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-600 text-white">
                      {(() => {
                        const Icon = cycle(APART_ICONS, i);
                        return <Icon className="h-5 w-5" />;
                      })()}
                    </span>
                    <E ed={ed} path={`apart.items.${i}.title`}>{t}</E>
                    <span className="ml-auto text-2xl font-light text-slate-500 group-open:rotate-45">+</span>
                  </summary>
                  <RichP value={d} attrs={ed(`apart.items.${i}.text`)} className="mt-3 pl-[60px] text-[15px] leading-relaxed text-slate-600" />
                </details>
              ))}
            </div>
          </div>
        </div>
      </section>

    
    ),
    // 10. (the public API section was removed: DIRECTOR.LTD makes no public-API promise. The key stays in the section registry
    // (styles.ts) so stored page orders remain valid; it simply renders nothing.)
    api: null,
    // 11. Use cases
    useCases: (
      <section className="py-24" style={secStyle("useCases")} {...ed("section:useCases")}>
        <div className="mx-auto max-w-7xl px-6">
          <div className="mx-auto max-w-3xl text-center">
            <Eyebrow attrs={ed("useCases.eyebrow")}>{c.useCases.eyebrow}</Eyebrow>
            <h2 className="mt-4 text-5xl font-extrabold tracking-tight text-indigo-900" style={hs("useCases.heading")} {...ed("useCases.heading")}>
              {leadPart("useCases.heading", `${c.useCases.heading.lead} `)}<span className="text-indigo-600" style={accent("useCases.heading")}>{c.useCases.heading.accent}</span>
            </h2>
            <RichP value={c.useCases.text} attrs={ed("useCases.text")} className="mt-4 text-lg text-slate-500" />
          </div>
          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {c.useCases.items.map(({ tag, title, text, image }, i) => {
              const grad = cycle(USE_CASE_TONES, i);
              return (
              <div key={`${i}-${tag}`} className="reveal overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className={`flex h-40 items-end bg-gradient-to-br ${grad} p-5${image ? " relative overflow-hidden" : ""}`} {...ed(`image:useCase.${i}`)}>
                  {image && (
                    // eslint-disable-next-line @next/next/no-img-element -- served by our own /media route
                    <img src={mediaSrc(image.mediaId)} alt={image.alt} loading="lazy" decoding="async" className={`absolute inset-0 h-full w-full ${image.fit === "contain" ? "object-contain" : "object-cover"}`} />
                  )}
                  <span className={`rounded-full ${image ? "relative bg-black/50" : "bg-white/15"} px-3 py-1 text-xs font-bold tracking-widest text-white`} {...ed(`useCases.items.${i}.tag`)}>{tag}</span>
                </div>
                <div className="p-6">
                  <h3 className="text-xl font-bold text-indigo-900" {...ed(`useCases.items.${i}.title`)}>{title}</h3>
                  <RichP value={text} attrs={ed(`useCases.items.${i}.text`)} className="mt-2 text-[15px] leading-relaxed text-slate-600" />
                </div>
              </div>
              );
            })}
          </div>
        </div>
      </section>

    
    ),
    // 12. FAQ
    faq: (
      <section id="faq" className="border-t border-slate-100 py-24" style={secStyle("faq")} {...ed("section:faq")}>
        <div className="mx-auto max-w-3xl px-6">
          <div className="text-center">
            <Eyebrow attrs={ed("faq.eyebrow")}>{c.faq.eyebrow}</Eyebrow>
            <h2 className="mt-4 text-5xl font-extrabold tracking-tight text-indigo-900" style={hs("faq.heading")} {...ed("faq.heading")}>{c.faq.heading}</h2>
          </div>
          <div className="mt-10 divide-y divide-slate-200 border-y border-slate-200">
            {faq.map(({ q, a, editableIndex }, i) => (
              <details key={`${i}-${q}`} className="group py-5" open={i === 0} {...(editableIndex === null ? lock(LOCK.claim) : {})}>
                <summary className="focus-ring flex cursor-pointer list-none items-center justify-between gap-4 text-left text-lg font-semibold text-indigo-900" {...(editableIndex === null ? {} : ed(`faq.items.${editableIndex}.q`))}>
                  {q}
                  <span className="text-2xl font-light text-indigo-600 group-open:hidden">+</span>
                  <span className="hidden text-2xl font-light text-indigo-600 group-open:inline">−</span>
                </summary>
                <RichP value={a} attrs={editableIndex === null ? undefined : ed(`faq.items.${editableIndex}.a`)} className="mt-3 max-w-2xl text-[15px] leading-relaxed text-slate-600" />
              </details>
            ))}
          </div>
        </div>
      </section>

    
    ),
    // 13. Final CTA
    finalCta: (
      <section className="bg-gradient-to-br from-indigo-900 to-indigo-950 py-20" style={secStyle("finalCta")} {...ed("section:finalCta")}>
        <div className="mx-auto max-w-4xl px-6 text-center">
          <h2 className="text-4xl font-extrabold tracking-tight text-white sm:text-5xl" style={hs("finalCta.heading")} {...ed("finalCta.heading")}>{c.finalCta.heading}</h2>
          <RichP value={c.finalCta.text} attrs={ed("finalCta.text")} className="mx-auto mt-4 max-w-xl text-lg text-blue-100" />
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row" style={row("final.buttons")}>
            <SiteButton id="final.primary" st={st} className="rounded-md !bg-white px-8 py-4 !text-indigo-900 hover:!bg-blue-50 focus-visible:!outline-white" strip={{ bg: ["!bg-white", "hover:!bg-blue-50"], color: ["!text-indigo-900"] }}>
              <E ed={ed} path="finalCta.primaryLabel">{`${c.finalCta.primaryLabel} `}</E><ArrowRight className="h-4 w-4" />
            </SiteButton>
            <SiteButton id="final.secondary" st={st} variant="outline" className="rounded-md !border-white/60 !bg-transparent px-8 py-4 !text-white hover:!bg-white/10 focus-visible:!outline-white" strip={{ bg: ["!bg-transparent", "hover:!bg-white/10"], color: ["!text-white"], border: ["!border-white/60"] }}>
              <E ed={ed} path="finalCta.secondaryLabel">{c.finalCta.secondaryLabel}</E>
            </SiteButton>
          </div>
        </div>
      </section>
    ),
  };

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-indigo-900 focus:shadow-lg focus-ring"
      >
        Skip to main content
      </a>
      <MarketingHeader content={c.header} ed={ed} />

      <main id="main" tabIndex={-1} className="flex-1 outline-none">
        {order.map((key) => {
          if (isCustomKey(key)) {
            const i = custom.findIndex((x) => `custom:${x.id}` === key);
            return i < 0 ? null : <CustomSectionView key={key} section={custom[i]} index={i} ed={edCustom(custom[i].id, i)} editing={editing} />;
          }
          return <Fragment key={key}>{parts[key]}</Fragment>;
        })}
      </main>

      <MarketingFooter content={c.footer} ed={ed} />
    </div>
  );
}
