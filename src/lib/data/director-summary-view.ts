import { RECORD_PACE_MIN_DAYS, estimateNote, formatApprox, formatCompact, formatDateTimeUtc, formatDuration, formatPercent, projectRecordCompletion, type AppointmentEstimate, type EstimateStatus, type RecordCompletion, type RecordDay } from "./director-progress-calc";
import { formatDateOnly } from "./format";

// Pure part of the Director Data summary (no database): inputs -> the ready-made text the card and modal show. See director-summary.ts for
// what each figure is and where it comes from. Two figures are kept strictly apart:
//   * IMPORTED = an ACTUAL count of director / LLP-member appointment records in the database (all statuses, current and historical);
//   * ESTIMATED TOTAL = imported + the ESTIMATE for the companies not yet checked. Always labelled an estimate.

export interface DirectorSummaryInput {
  now: Date;
  asOf?: Date; // when the figures were read from the database (defaults to now)
  imported: { current: number; historical: number } | null; // actual Director rows; null = could not be read
  importedToday?: number | null; // actual Director rows inserted since 00:00 UTC; null = could not be read
  estimate: AppointmentEstimate | null; // the estimate for the companies not yet checked
  estimateStatus: EstimateStatus;
  lastUpdateAt: Date | null;
  recordHistory?: { daily: RecordDay[]; firstDay: string | null } | null; // director / LLP-member records imported per UTC day: the basis of the completion estimate
  requestsToday: number | null; // null = the ledger could not be read
  cap: number | null; // null = no worker run has recorded its cap; 0 = no cap
}

export interface DirectorSummaryView {
  asOfText: string;
  importedToday: { value: string | null };
  imported: {
    value: string | null; // "1,431,205": the exact count
    total: number | null; // the same count as a number (the dashboard card)
    title: string | null;
  };
  estimate: {
    state: EstimateStatus;
    value: string | null; // "≈ 17.1M": estimated TOTAL appointment records across ALL UK companies = imported + remaining. null unless a defensible all-status estimate exists
    range: string | null; // "16.9M–17.2M" (total)
    remaining: string | null; // "15.7M": estimated total minus imported
    status: string | null; // small neutral text instead of a figure while no defensible all-status estimate exists
    note: string | null;
    calculatedAt: string | null;
    title: string | null;
  };
  lastUpdate: { text: string; iso: string | null };
  eta: {
    state: "ready" | "unavailable";
    value: string | null; // "about 18 months"
    date: string | null; // "27 May 2028"
    provisional: boolean;
    note: string; // why it is provisional / unavailable
    pace: string | null; // "24,280 companies a day"
    short: string; // the one-line basis shown under the figure (only when there is a date)
    status: string | null; // a small neutral status instead of a figure while no reliable all-status estimate exists ("Awaiting dissolved processing data")
  };
  api: {
    state: "ok" | "no_cap" | "unknown";
    used: string | null;
    cap: string | null;
    remaining: string | null;
    percentText: string | null;
    barPercent: number;
    warn: boolean;
  };
}

const n = (v: number) => v.toLocaleString("en-GB");

function buildEta(c: RecordCompletion | null): DirectorSummaryView["eta"] {
  const off = (status: string, note: string): DirectorSummaryView["eta"] => ({ state: "unavailable", value: null, date: null, provisional: false, note, pace: null, short: "", status });
  if (!c) return off("Not yet available", "A completion time needs the verified estimate of the records still to import.");
  if (c.state === "complete") return { state: "ready", value: "Complete", date: null, provisional: false, note: "No records remain to import.", pace: null, short: "", status: null };
  if (c.state === "no_history") return off("Collecting import history", "Needs at least " + RECORD_PACE_MIN_DAYS + " complete UTC days of record imports to measure a pace.");
  if (c.state === "no_recent_imports") return off("No recent imports", "No director records were imported in the last " + c.windowDays + " complete UTC days, so there is no pace to project.");
  return {
    state: "ready",
    value: "about " + formatDuration(c.days as number),
    date: formatDateOnly(c.date),
    provisional: false,
    note:
      "Remaining records (estimated total minus imported) divided by the records actually imported per day: " + n(Math.round(c.perDay as number)) + " a day, from " + n(c.recordsInWindow) + " director and LLP-member records over the last " + c.windowDays +
      " complete UTC days, inactive days counted as zero. It assumes the current pace continues.",
    pace: n(Math.round(c.perDay as number)) + " records a day",
    short: "last " + c.windowDays + " days",
    status: null,
  };
}

export function buildDirectorSummaryView(i: DirectorSummaryInput): DirectorSummaryView {
  const e = i.estimate;
  const imp = i.imported;
  const importedTotal = imp ? imp.current + imp.historical : null;
  // An all-status total exists ONLY when every company is covered by a defensible sample: no unchecked company is left without one, and the
  // dissolved companies are not excluded. A live-only figure is never shown as the UK total.
  const supported = !!e && e.uncoveredCompanies === 0 && !e.provisional;
  const ready = supported && importedTotal !== null;
  const est = e as AppointmentEstimate;
  const total = ready ? (importedTotal as number) + est.total : null;
  const used = i.requestsToday;
  const capped = i.cap !== null && i.cap > 0;
  const remaining = used !== null && capped ? Math.max(0, (i.cap as number) - used) : null;
  const percent = used !== null && capped ? Math.min(100, (used / (i.cap as number)) * 100) : null;
  return {
    asOfText: formatDateTimeUtc((i.asOf ?? i.now).toISOString()),
    importedToday: { value: i.importedToday === null || i.importedToday === undefined ? null : n(i.importedToday) },
    imported: {
      value: importedTotal === null ? null : n(importedTotal),
      total: importedTotal,
      title: imp
        ? "Actual count of director and LLP-member appointment records stored in the database: current (no resignation date, company not dissolved) and historical (resigned, or in a dissolved company), all company statuses. Secretaries and other officers are not counted. Appointments, not unique people."
        : null,
    },
    estimate: {
      state: ready ? "ready" : i.estimateStatus === "calculating" ? "calculating" : "unavailable",
      value: total === null ? null : "≈ " + formatApprox(total),
      range: ready ? formatCompact((importedTotal as number) + est.low) + "–" + formatCompact((importedTotal as number) + est.high) : null,
      remaining: ready ? formatCompact(est.total) : null,
      status: ready ? null : i.estimateStatus === "calculating" ? "Calculating…" : "Not yet available",
      note: estimateNote(e),
      calculatedAt: e ? formatDateTimeUtc(e.asOf) : null,
      title: ready
        ? "Estimate, not an exact count: about " + formatApprox(total as number) + " director and LLP-member appointment records (not unique people) across ALL UK companies, every status (range " + formatCompact((importedTotal as number) + est.low) + "–" + formatCompact((importedTotal as number) + est.high) + "). That is the " + n(importedTotal as number) + " records already imported (an actual count) plus about " + formatCompact(est.total) + " estimated for the companies not yet checked. Not every company is checked: " + n(est.dissolvedChecked) + " dissolved companies were individually checked (" + n(est.dissolvedSampled ?? 0) + " of them the random sample); the " + n(est.dissolvedEstimated ?? 0) + " unchecked dissolved companies are estimated from that sample, year by year, and are not individually checked. The range reflects sampling error only. Appointments, not unique people. Calculated " + formatDateTimeUtc(est.asOf) + "."
        : "No total is shown: an estimate across ALL UK companies needs a representative sample of dissolved companies from every dissolution year, and one has not been collected yet. A figure for live companies alone would understate the UK total, so it is not shown.",
    },
    lastUpdate: { text: i.lastUpdateAt ? formatDateTimeUtc(i.lastUpdateAt.toISOString()) : "No update recorded yet", iso: i.lastUpdateAt ? i.lastUpdateAt.toISOString() : null },
    // remaining records = the verified estimate's remaining (estimated total - imported), only when an all-status estimate exists
    eta: buildEta(ready && i.recordHistory ? projectRecordCompletion({ now: i.now, daily: i.recordHistory.daily, firstDay: i.recordHistory.firstDay, remaining: est.total }) : null),
    api: {
      state: used === null || i.cap === null ? "unknown" : capped ? "ok" : "no_cap",
      used: used === null ? null : n(used),
      cap: capped ? n(i.cap as number) : null,
      remaining: remaining === null ? null : n(remaining),
      percentText: percent === null ? null : formatPercent(percent),
      barPercent: percent === null ? 0 : Math.max(percent, percent > 0 ? 1 : 0),
      warn: percent !== null && percent >= 90,
    },
  };
}
