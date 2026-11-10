"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { Building2, Network } from "lucide-react";
import type { StructureCompany } from "@/lib/data/structure-company";

// The Corporate structure section: ONE REAL company from the register at the centre, and what DIRECTOR.LTD can verify about its
// ownership. It holds no parent, subsidiary or beneficial-owner data (lib/data/structure-company.ts explains why), so the three slots
// beside the company are drawn as empty and show DNL (the client's display text for data that is unavailable; it is not expanded or
// explained further here, and it never means that no relationship exists). Nothing here is invented: every word about the company comes from
// its record, and the slots carry no names, numbers or percentages. When verified data exists one day, it fills these slots.
//
// Pure CSS and markup (no animation library). Motion lives in globals.css (.cs-*) and is wrapped in
// prefers-reduced-motion: no-preference, so with reduced motion everything is simply drawn, still. The visibility toggles below set
// plain attributes on the element (no React state, no re-render, no layout shift): the entrance is armed only when the diagram starts
// below the fold, so content that is already on screen never flashes away and back.
const SLOTS = ["Parent company", "Subsidiaries", "Beneficial owners"];

export function CorporateStructure({ company = null }: { company?: StructureCompany | null }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const show = () => el.setAttribute("data-inview", "true");
    const rect = el.getBoundingClientRect();
    if (typeof IntersectionObserver === "undefined" || rect.top < window.innerHeight * 0.9) {
      show();
      return;
    }
    el.setAttribute("data-armed", "true");
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          show();
          observer.disconnect();
        }
      },
      { threshold: 0.25 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className="cs-root relative min-w-0 rounded-3xl border border-slate-200 bg-gradient-to-br from-indigo-50/70 via-white to-white p-6 sm:p-8"
      role="group"
      aria-label={
        company
          ? `Corporate structure of ${company.name}, company number ${company.companyNumber}. Parent company, subsidiaries and beneficial owners are shown as DNL: the data is unavailable.`
          : "Corporate structure. No company could be loaded to show. Parent company, subsidiaries and beneficial owners are shown as DNL: the data is unavailable."
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-indigo-200 bg-white px-3 py-1 text-xs font-semibold text-indigo-700">
          <Network className="h-3.5 w-3.5" aria-hidden /> {company ? "Real company record" : "No company to show"}
        </span>
        <span className="text-xs text-slate-500">Ownership data: DNL</span>
      </div>

      <div className="mt-6 md:flex md:items-center">
        <div className="cs-node relative md:w-72 md:shrink-0" style={{ "--i": 0 } as React.CSSProperties}>
          <div className="cs-card rounded-2xl border border-indigo-300 bg-white p-4 shadow-sm shadow-indigo-900/5">
            <span className="inline-flex rounded-full bg-indigo-900 px-2.5 py-0.5 text-[11px] font-semibold text-white">{company ? "Selected company" : "Selected company · none"}</span>
            {company ? (
              <>
                <div className="mt-3 flex items-center gap-2.5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-white">
                    <Building2 className="h-[18px] w-[18px]" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <p className="break-words text-sm font-semibold text-indigo-950">{company.name}</p>
                    <p className="text-xs text-slate-500">Company number {company.companyNumber}</p>
                  </div>
                </div>
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-2 text-xs">
                  <dt className="text-slate-500">Status</dt>
                  <dd className="font-medium text-slate-700">{company.status}</dd>
                  <dt className="text-slate-500">Type</dt>
                  <dd className="font-medium text-slate-700">{company.typeLabel}</dd>
                  <dt className="text-slate-500">Incorporated</dt>
                  <dd className="font-medium text-slate-700">{company.incorporated}</dd>
                  <dt className="text-slate-500">Officers</dt>
                  <dd className="font-medium text-slate-700">{company.officers === null ? "Not yet confirmed" : `${company.officers} confirmed`}</dd>
                </dl>
                <Link href={`/companies/${company.id}`} className="focus-ring mt-3 inline-flex text-xs font-semibold text-indigo-600 hover:text-indigo-800">
                  Open company record
                </Link>
              </>
            ) : (
              <p className="mt-3 text-sm text-slate-600">No real company record could be loaded right now, so none is shown.</p>
            )}
          </div>
          {/* desktop: a line from the company to the spine; mobile: a short line down to the first slot */}
          <span aria-hidden className="cs-line cs-hline absolute left-full top-1/2 hidden h-0.5 w-10 -translate-y-1/2 md:block" style={{ "--i": 0 } as React.CSSProperties} />
          <span aria-hidden className="cs-line cs-vline-short relative ml-6 block h-6 w-0.5 md:hidden" />
        </div>

        <div className="relative mt-0 md:ml-10 md:flex-1">
          <span aria-hidden className="cs-line cs-vline absolute bottom-6 left-6 top-6 w-0.5 md:left-0" />
          <ul className="space-y-3 pl-12 md:pl-6">
            {SLOTS.map((title, i) => (
              <li key={title} className="cs-node relative" style={{ "--i": i + 1 } as React.CSSProperties}>
                <span aria-hidden className="cs-line cs-hline absolute -left-6 top-1/2 h-0.5 w-6 -translate-y-1/2" style={{ "--i": i + 1 } as React.CSSProperties} />
                <div className="cs-card flex items-center gap-3 rounded-xl border border-dashed border-slate-300 bg-white/70 px-4 py-3">
                  <span className="min-w-0 flex-1 break-words text-sm font-semibold text-indigo-950">{title}</span>
                  <span className="shrink-0 rounded-md bg-slate-100 px-2.5 py-1 text-xs font-bold tracking-wider text-slate-600">
                    DNL<span className="sr-only">: data unavailable</span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <p className="mt-6 text-xs leading-relaxed text-slate-500">
        The company above is a real register record. DIRECTOR.LTD does not hold parent, subsidiary or beneficial ownership data, so no relationship is shown or implied. DNL marks data that is unavailable; it does not mean that no relationship exists.{" "}
        <Link href="/companies" className="focus-ring font-semibold text-indigo-600 hover:text-indigo-800">
          Search for another company
        </Link>
        .
      </p>
    </div>
  );
}
