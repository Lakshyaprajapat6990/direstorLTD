"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent } from "react";
import Link from "next/link";
import { Search, ListChecks, Users, Tag, FileSpreadsheet, RefreshCw, Star, ArrowRight, CheckCircle2, ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { DEFAULT_SITE_CONTENT, type SiteContent } from "@/lib/site-content/defaults";
import { COUNTRY_OPTIONS, DIRECTOR_OPTIONS, FILING_OPTIONS, MAX_QUERY_LENGTH, TYPE_OPTIONS, parseHomeSearch, validateHomeSearch, type SearchMode } from "@/lib/home-search";
import { RichP } from "./RichText";
import { E, editEd, noEd, type Ed } from "./cms-edit";

function Segmented<T extends string>({
  items,
  value,
  onChange,
  label,
  idBase,
  ed = noEd,
}: {
  items: { id: T; label: string; icon: React.ComponentType<{ className?: string }>; path?: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  idBase: string;
  ed?: Ed;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  // Automatic activation: arrow keys / Home / End move focus and select, and only the selected tab is in the tab order.
  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    const last = items.length - 1;
    const next = e.key === "ArrowRight" ? (index === last ? 0 : index + 1) : e.key === "ArrowLeft" ? (index === 0 ? last : index - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    onChange(items[next].id);
    refs.current[items[next].id]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="mx-auto inline-flex flex-wrap justify-center gap-1 rounded-3xl border border-slate-200 bg-white p-1.5 shadow-sm">
      {items.map(({ id, label: l, icon: Icon, path }, index) => (
        <button
          key={id}
          {...(path ? ed(path) : {})}
          ref={(el) => {
            refs.current[id] = el;
          }}
          type="button"
          role="tab"
          id={`${idBase}-tab-${id}`}
          aria-selected={value === id}
          aria-controls={`${idBase}-panel`}
          tabIndex={value === id ? 0 : -1}
          onClick={() => onChange(id)}
          onKeyDown={(e) => onKeyDown(e, index)}
          className={cn(
            "focus-ring inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition-colors",
            value === id ? "bg-indigo-900 text-white" : "text-indigo-900 hover:bg-slate-100"
          )}
        >
          <Icon className="h-4 w-4" aria-hidden />
          {l}
        </button>
      ))}
    </div>
  );
}

// Tab ids and icons are structure and stay here; labels, hints and field lists arrive as content.
const SEARCH_TAB_DEFS = [
  { id: "company", icon: Search },
  { id: "filings", icon: ListChecks },
  { id: "directors", icon: Users },
  { id: "sic", icon: Tag },
] as const;

export type SearchShowcaseContent = SiteContent["search"]["tabs"];

// What each tab asks for. The label, placeholder and input rules change with the mode so the box always matches what will be searched.
const MODE_INPUT = {
  company: { label: "Company name, number or postcode", placeholder: "Company name, number or postcode", numeric: false, maxLength: MAX_QUERY_LENGTH },
  filings: { label: "Optional: company name, number or postcode", placeholder: "Optional: name, number or postcode", numeric: false, maxLength: MAX_QUERY_LENGTH },
  directors: { label: "Optional: company name, number or postcode", placeholder: "Optional: name, number or postcode", numeric: false, maxLength: MAX_QUERY_LENGTH },
  sic: { label: "SIC code (2 to 5 digits)", placeholder: "SIC code, for example 62012", numeric: true, maxLength: 5 },
} as const;

const selectClass = "focus-ring w-full appearance-none rounded-lg border border-slate-200 bg-white py-3 pl-4 pr-10 text-sm font-medium text-indigo-900 hover:border-slate-300";

function SelectField({ label, name, value, onChange, children }: { label: string; name?: string; value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <label className="relative block">
      <span className="sr-only">{label}</span>
      <select name={name} value={value} onChange={(e) => onChange(e.target.value)} className={selectClass}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
    </label>
  );
}

// The public search box. It is a real form: it sends the visitor (GET) to the existing UK Companies page with the chosen mode and
// filters in the address (lib/home-search.ts). That page needs a signed-in user, so a signed-out visitor is taken to sign in and
// returned to the SAME search afterwards (the proxy keeps the whole address; the sign-in page only follows same-site paths). It never
// fabricates results here: the answers always come from the real search on the other side.
// `editing` (a boolean, so this can be rendered from a server component) turns on the editor's data-cms markers and keeps the
// Super Admin's canvas from navigating away.
export function SearchShowcase({ content = DEFAULT_SITE_CONTENT.search.tabs, editing = false }: { content?: SearchShowcaseContent; editing?: boolean }) {
  const ed = editing ? editEd : noEd;
  const tabs = SEARCH_TAB_DEFS.map((d) => ({ ...d, ...content[d.id] }));
  const [tab, setTab] = useState<SearchMode>("company");
  const [text, setText] = useState("");
  const [type, setType] = useState("");
  const [filing, setFiling] = useState("");
  const [directors, setDirectors] = useState("");
  const [country, setCountry] = useState<string>(COUNTRY_OPTIONS[0].value);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const current = tabs.find((t) => t.id === tab) ?? tabs[0];
  const idBase = useId();
  const input = MODE_INPUT[tab];
  const errorId = `${idBase}-error`;

  // Back/forward restores the page from memory with the button still "busy": release it.
  useEffect(() => {
    const onShow = () => setBusy(false);
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  function changeTab(next: SearchMode) {
    setTab(next);
    setError(null);
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    if (editing || busy) {
      e.preventDefault(); // the editor's canvas never navigates; a second click while a search is being sent does nothing
      return;
    }
    // Validate with the same rules the page behind it applies. A valid search is left to the browser to submit (a normal GET).
    const search = parseHomeSearch(new URLSearchParams({ mode: tab, ...(tab === "sic" ? { sic: text } : { q: text }), type, filing, directors }));
    const problem = validateHomeSearch(search);
    if (problem) {
      e.preventDefault();
      setError(problem);
      inputRef.current?.focus();
      return;
    }
    setError(null);
    setBusy(true);
  }

  return (
    <div>
      <Segmented items={tabs.map(({ id, label, icon }) => ({ id, label, icon, path: `search.tabs.${id}.label` }))} value={tab} onChange={changeTab} label="What to search" idBase={idBase} ed={ed} />
      <div role="tabpanel" id={`${idBase}-panel`} aria-labelledby={`${idBase}-tab-${tab}`} className="mx-auto mt-6 max-w-4xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-lg shadow-slate-200/60">
        <form role="search" aria-label={current.label} action="/companies" method="get" onSubmit={onSubmit} noValidate aria-busy={busy}>
          <input type="hidden" name="mode" value={tab} />
          <div className="flex items-center gap-3 px-6 py-4">
            <label htmlFor={`${idBase}-q`} className="sr-only">
              {input.label}
            </label>
            <Search className="h-5 w-5 shrink-0 text-slate-400" aria-hidden />
            <input
              ref={inputRef}
              id={`${idBase}-q`}
              name={text ? (tab === "sic" ? "sic" : "q") : undefined}
              type="search"
              value={text}
              onChange={(e) => {
                setText(tab === "sic" ? e.target.value.replace(/\D/g, "") : e.target.value);
                if (error) setError(null);
              }}
              inputMode={input.numeric ? "numeric" : "search"}
              maxLength={input.maxLength}
              autoComplete="off"
              placeholder={input.placeholder}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              readOnly={busy} // read-only, not disabled: a disabled field is left out of the form that is being sent
              className="min-w-0 flex-1 bg-transparent text-lg text-slate-900 outline-none placeholder:text-slate-400 read-only:opacity-60"
            />
            <button type="submit" aria-label="Search" disabled={busy} className="focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-white transition-colors hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-70">
              {busy ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : <ArrowRight className="h-5 w-5" aria-hidden />}
            </button>
          </div>
          <p className="px-6 pb-3 text-sm text-slate-500" {...ed(`search.tabs.${current.id}.hint`)}>{current.hint}</p>
          {error && (
            <p id={errorId} role="alert" className="px-6 pb-3 text-sm font-medium text-red-600">
              {error}
            </p>
          )}
          <div className="grid gap-2 border-t border-slate-100 p-3 sm:grid-cols-2">
            <SelectField label="Country" value={country} onChange={setCountry} name={undefined}>
              {COUNTRY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </SelectField>
            <SelectField label="Company type" name={type ? "type" : undefined} value={type} onChange={setType}>
              <option value="">All company types</option>
              {TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </SelectField>
            {tab === "filings" && (
              <div className="sm:col-span-2">
                <SelectField label="Filing position" name={filing ? "filing" : undefined} value={filing} onChange={setFiling}>
                  <option value="">Any filing position</option>
                  {FILING_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </SelectField>
              </div>
            )}
            {tab === "directors" && (
              <div className="sm:col-span-2">
                <SelectField label="Director position" name={directors ? "directors" : undefined} value={directors} onChange={setDirectors}>
                  <option value="">Any number of directors</option>
                  {DIRECTOR_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </SelectField>
              </div>
            )}
          </div>
          <p className="border-t border-slate-100 px-6 py-2.5 text-xs text-slate-500">
            UK register only. Searching needs a free or staff account: you will be asked to sign in, then your search runs.
            {tab === "directors" ? " Director filters use the director data DIRECTOR.LTD has confirmed so far, not every company." : ""}
          </p>
        </form>
        <div className="border-t border-slate-100 px-6 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Fields you can use</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {current.fields.map((f, i) => (
              <span key={`${i}-${f}`} className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700" {...ed(`search.tabs.${current.id}.fields.${i}`)}>
                {f}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const WORKFLOW_TAB_DEFS = [
  { id: "lists", icon: ListChecks },
  { id: "reports", icon: FileSpreadsheet },
  { id: "crm", icon: Star },
] as const;

export type WorkflowShowcaseContent = Pick<SiteContent["workflow"], "tabs" | "steps" | "tryLabel">;

// Which step of the flow each tab is about (0-based).
const ACTIVE_STEP = { lists: 1, reports: 3, crm: 4 } as const;

export function WorkflowShowcase({ content = DEFAULT_SITE_CONTENT.workflow, editing = false, tryStyle }: { content?: WorkflowShowcaseContent; editing?: boolean; tryStyle?: CSSProperties }) {
  const ed = editing ? editEd : noEd;
  const tabs = WORKFLOW_TAB_DEFS.map((d) => ({ ...d, ...content.tabs[d.id] }));
  const [tab, setTab] = useState<(typeof WORKFLOW_TAB_DEFS)[number]["id"]>("lists");
  const t = tabs.find((x) => x.id === tab) ?? tabs[0];
  const idBase = useId();
  return (
    <div>
      <Segmented items={tabs.map(({ id, label, icon }) => ({ id, label, icon, path: `workflow.tabs.${id}.label` }))} value={tab} onChange={setTab} label="Workflow" idBase={idBase} ed={ed} />
      <div role="tabpanel" id={`${idBase}-panel`} aria-labelledby={`${idBase}-tab-${tab}`} className="mt-12 grid items-center gap-12 lg:grid-cols-2">
        <div>
          <span className="inline-block rounded-full border border-indigo-100 bg-indigo-50 px-3.5 py-1 text-sm font-medium text-indigo-700" {...ed(`workflow.tabs.${t.id}.badge`)}>{t.badge}</span>
          <h3 className="mt-5 text-4xl font-bold tracking-tight text-indigo-900" {...ed(`workflow.tabs.${t.id}.title`)}>{t.title}</h3>
          <RichP value={t.text} attrs={ed(`workflow.tabs.${t.id}.text`)} className="mt-4 text-lg leading-relaxed text-slate-600" />
          <ul className="mt-6 space-y-3">
            {t.bullets.map((b, i) => (
              <li key={`${i}-${b}`} className="flex items-start gap-3 text-[15px] text-indigo-900" {...ed(`workflow.tabs.${t.id}.bullets.${i}`)}>
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-indigo-600" />
                {b}
              </li>
            ))}
          </ul>
          <Link href="/login" style={tryStyle} className="focus-ring mt-8 inline-flex items-center gap-2 rounded-md bg-indigo-600 px-6 py-3.5 text-base font-semibold text-white hover:bg-indigo-700">
            <E ed={ed} path="workflow.tryLabel">{`${content.tryLabel} `}</E><ArrowRight className="h-4 w-4" />
          </Link>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-lg shadow-slate-200/60">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">How it fits together</p>
          <ol className="mt-4 space-y-3">
            {content.steps.map((s, i) => (
              <li key={`${i}-${s}`} className={cn("flex items-center gap-3 rounded-lg border px-4 py-3 text-sm font-semibold", i === ACTIVE_STEP[tab] ? "border-indigo-200 bg-indigo-50 text-indigo-900" : "border-slate-200 text-slate-700")} {...ed(`workflow.steps.${i}`)}>
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-900 text-xs text-white">{i + 1}</span>
                {s}
                {i === 3 && <RefreshCw className="ml-auto h-4 w-4 text-slate-400" />}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}
