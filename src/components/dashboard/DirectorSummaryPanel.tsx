"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import {
  Activity,
  BarChart3,
  CalendarDays,
  ChevronRight,
  Clock,
  Database,
  Hourglass,
  Sigma,
} from "lucide-react";
import { Dialog } from "@/app/(app)/admin/website-content/editor/Dialog"; // the project's accessible modal (focus trap, Escape, backdrop, focus returns)
import type { DirectorSummaryView } from "@/lib/data/director-summary-view";

// The Director Data card's detail lines and its modal. Every string arrives ready-made from the server (buildDirectorSummaryView); nothing here
// calculates or formats a number. IMPORTED is an actual database count; the ESTIMATED TOTAL is imported + an estimate and is always labelled so.

export function DirectorSummaryPanel({ view }: { view: DirectorSummaryView }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  // Keyboard users must land back on the link after closing. The shared Dialog restores whatever had focus when it opened, but Safari and
  // Firefox do not focus a button on click (that would be the page body), so the link puts focus back itself.
  useEffect(() => {
    const returning = wasOpen.current && !open;
    wasOpen.current = open;
    if (!returning) return;
    trigger.current?.focus();
    const again = setTimeout(() => trigger.current?.focus(), 0); // a backdrop click moves focus to the page AFTER our handler ran
    return () => clearTimeout(again);
  }, [open]);

  // While the estimate is still being calculated, ask the server again every few seconds (a dozen times at most). If it cannot be calculated
  // the state becomes "unavailable" and the polling stops.
  const router = useRouter();
  const polls = useRef(0);
  useEffect(() => {
    if (view.estimate.state !== "calculating" || polls.current >= 12) return;
    const t = setTimeout(() => {
      polls.current += 1;
      router.refresh();
    }, 5000);
    return () => clearTimeout(t);
  }, [view, router]);

  const api = view.api;
  const update = view.lastUpdate;
  const e = view.estimate;
  const imp = view.imported;
  return (
    <>
      {/* ---------- on the dashboard card: ONLY the link. It sits in the free space to the right of the icon, so the card keeps the exact
          layout and height of its neighbours (a longer or shorter wording is chosen by the width of the card). ---------- */}
      <div className="@container pointer-events-none absolute inset-x-0 top-0 flex h-9 items-center justify-end">
        <button
          ref={trigger}
          type="button"
          data-testid="director-progress-open"
          aria-haspopup="dialog"
          aria-label="View processing progress"
          title={`View processing progress (figures as of ${view.asOfText})`}
          onClick={() => setOpen(true)}
          className="pointer-events-auto flex max-w-full items-center gap-1 whitespace-nowrap rounded-full bg-white/70 px-2 py-0.5 text-[11px] font-semibold leading-[14px] text-violet-700 ring-1 ring-violet-200 hover:bg-white hover:underline focus-ring"
        >
          <BarChart3 className="h-3 w-3 shrink-0" aria-hidden />
          <span className="@[12rem]:hidden">Progress</span>
          <span className="hidden @[12rem]:inline @[14.75rem]:hidden">
            Processing progress
          </span>
          <span className="hidden @[14.75rem]:inline">
            View processing progress
          </span>
          <ChevronRight
            className="hidden h-3 w-3 shrink-0 @[12rem]:block"
            aria-hidden
          />
        </button>
      </div>

      {open &&
        createPortal(
          <Dialog
            open
            title="Director data"
            onClose={() => setOpen(false)}
            size="lg"
          >
            <div
              data-testid="director-summary-panel"
              className="-mt-1 space-y-2.5"
            >
              <p className="flex items-center gap-1.5 text-xs text-slate-500">
                <Clock
                  className="h-3.5 w-3.5 shrink-0 text-slate-400"
                  aria-hidden
                />
                <span>
                  Figures as of{" "}
                  <span className="font-semibold text-slate-800">
                    {view.asOfText}
                  </span>
                </span>
              </p>

              <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
                {/* ---------- 4. Total Director Data Imported: an ACTUAL database count ---------- */}
                <section
                  data-card="imported"
                  aria-labelledby="ds-imported-title"
                  title={imp.title ?? undefined}
                  className="rounded-xl border border-violet-200 bg-gradient-to-br from-violet-50 to-white px-4 py-3 shadow-sm"
                >
                  <h3
                    id="ds-imported-title"
                    className="flex items-center gap-2 text-[13px] font-bold text-violet-800"
                  >
                    <Database className="h-4 w-4 shrink-0" aria-hidden />
                    Total Director Data Imported
                  </h3>
                  <p
                    data-testid="ds-imported"
                    className="mt-2 whitespace-nowrap text-3xl font-extrabold leading-none tabular-nums tracking-tight text-violet-700"
                  >
                    {imp.value ?? "Unavailable"}
                  </p>
                  <p className="mt-1.5 text-[11px] text-slate-500">
                    Appointment records stored (not companies)
                  </p>
                </section>

                {/* ---------- 5. Estimated Total Director Data: ALL UK companies, or no figure ---------- */}
                <section
                  data-card="total"
                  aria-labelledby="ds-total-title"
                  title={e.title ?? undefined}
                  className="rounded-xl border border-amber-200 bg-gradient-to-br from-amber-50/70 to-white px-4 py-3 shadow-sm"
                >
                  <h3
                    id="ds-total-title"
                    data-testid="ds-total-title"
                    className="flex items-center gap-2 text-[13px] font-bold text-amber-900"
                  >
                    <Sigma className="h-4 w-4 shrink-0" aria-hidden />
                    Estimated Total Director Data
                  </h3>
                  {e.value ? (
                    <>
                      <p
                        data-testid="ds-total"
                        className="mt-2 whitespace-nowrap text-3xl font-extrabold leading-none tabular-nums tracking-tight text-amber-700"
                      >
                        {e.value}
                      </p>
                      <p
                        data-testid="ds-total-detail"
                        className="mt-1.5 text-[11px] text-slate-500"
                      >
                        Estimated appointment records across UK companies
                      </p>
                    </>
                  ) : (
                    <p
                      data-testid="ds-total"
                      className="mt-2.5 text-[13px] font-medium leading-snug text-slate-500"
                    >
                      {e.status}
                    </p>
                  )}
                </section>
              </div>

              <div className="grid grid-cols-1 gap-2.5 md:grid-cols-3">
                {/* ---------- 1. Last Successful Update ---------- */}
                <section
                  data-card="update"
                  aria-label="Last successful update"
                  className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm"
                >
                  <h3 className="flex items-center gap-2 text-[13px] font-bold text-slate-800">
                    <Clock
                      className="h-4 w-4 shrink-0 text-emerald-600"
                      aria-hidden
                    />
                    Last Successful Update
                  </h3>
                  <p
                    data-testid="ds-update"
                    className="mt-2 text-base font-bold tabular-nums text-slate-900"
                  >
                    {update.text}
                  </p>
                </section>

                {/* ---------- 2. Total API Requests Today (shared ledger) ---------- */}
                <section
                  data-card="api"
                  data-testid="ds-api"
                  aria-label="Total API requests today"
                  className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm"
                >
                  <h3 className="flex items-center gap-2 text-[13px] font-bold text-slate-800">
                    <Activity
                      className="h-4 w-4 shrink-0 text-sky-600"
                      aria-hidden
                    />
                    Total API Requests Today
                  </h3>
                  {api.used === null ? (
                    <p className="mt-2 text-xs text-slate-500">
                      Not available just now
                    </p>
                  ) : (
                    <>
                      <p className="mt-2 text-base tabular-nums text-slate-600">
                        <span
                          data-testid="ds-api-used"
                          className="font-bold text-slate-900"
                        >
                          {api.used}
                        </span>
                        {api.cap ? (
                          <>
                            {" "}
                            / <span data-testid="ds-api-cap">
                              {api.cap}
                            </span>{" "}
                            limit
                          </>
                        ) : (
                          <> requests today (no limit recorded)</>
                        )}
                      </p>
                      {api.cap && (
                        <>
                          <div
                            role="progressbar"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={
                              Math.round(api.barPercent * 100) / 100
                            }
                            aria-label={`${api.percentText} of today's request limit used`}
                            className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-200"
                          >
                            <div
                              className={`h-full rounded-full ${api.warn ? "bg-amber-500" : "bg-sky-500"}`}
                              style={{ width: `${api.barPercent}%` }}
                            />
                          </div>
                          <p
                            className={`mt-1 text-xs font-semibold tabular-nums ${api.warn ? "text-amber-700" : "text-slate-600"}`}
                          >
                            <span data-testid="ds-api-remaining">
                              {api.remaining}
                            </span>{" "}
                            requests remaining today
                          </p>
                        </>
                      )}
                    </>
                  )}
                </section>

                {/* ---------- 3. Director Data Imported Today: actual rows inserted since 00:00 UTC ---------- */}
                <section
                  data-card="today"
                  aria-label="Director data imported today"
                  className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm"
                >
                  <h3 className="flex items-center gap-2 text-[13px] font-bold text-slate-800">
                    <CalendarDays
                      className="h-4 w-4 shrink-0 text-violet-600"
                      aria-hidden
                    />
                    Director Data Imported Today
                  </h3>
                  <p
                    data-testid="ds-today"
                    className="mt-2 text-base font-bold tabular-nums text-slate-900"
                  >
                    {view.importedToday.value ?? "Unavailable"}
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    appointment records, since 00:00 UTC
                  </p>
                </section>
              </div>

              {/* ---------- 6. Estimated Time to Complete: remaining RECORDS / records imported per day ---------- */}
              <section
                data-card="eta"
                aria-label="Estimated time to complete"
                title={view.eta.note}
                className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm"
              >
                <h3
                  data-testid="ds-eta-title"
                  className="flex items-center gap-2 whitespace-nowrap text-[13px] font-bold text-slate-800"
                >
                  <Hourglass
                    className="h-4 w-4 shrink-0 text-blue-600"
                    aria-hidden
                  />
                  Estimated Time to Complete
                </h3>
                {view.eta.value ? (
                  <>
                    <p
                      data-testid="ds-eta"
                      className="mt-2 whitespace-nowrap text-base font-bold tabular-nums text-slate-900"
                    >
                      {view.eta.value}
                    </p>
                    {view.eta.pace && (
                      <p
                        data-testid="ds-eta-note"
                        className="mt-0.5 text-[11px] leading-snug text-slate-500"
                      >
                        {view.eta.date ? (
                          <>Estimated completion {view.eta.date} · </>
                        ) : null}
                        based on {view.eta.pace} ({view.eta.short}) · an
                        estimate, not a deadline
                      </p>
                    )}
                  </>
                ) : (
                  <p
                    data-testid="ds-eta"
                    className="mt-2.5 text-[13px] font-medium leading-snug text-slate-500"
                  >
                    {view.eta.status}
                  </p>
                )}
              </section>
            </div>
          </Dialog>,
          document.body,
        )}
    </>
  );
}
