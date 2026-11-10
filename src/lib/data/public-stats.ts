import { getRegisterBreakdown, type RegisterBreakdown } from "@/lib/data/companies";
import { getDataFreshness, type DataFreshness } from "@/lib/data/freshness";
import { makeLogger } from "@/lib/log";

// The aggregate figures the public landing page may show, and nothing else.
//
// There is deliberately no second calculation here: the figures come from getRegisterBreakdown(), the same function the
// dashboard uses (same seed exclusion, same grouping, same cache), so the two surfaces cannot disagree. This module only
//   - narrows the result to the approved public fields,
//   - turns a failure or an empty register into an explicit state instead of a 0 or an exception,
//   - decides whether the freshness date really means "company data was synchronised", and
//   - makes concurrent callers share one in-flight load.
// These values are database-derived and must never become editable content.

const log = makeLogger("public-stats");

export interface PublicRegisterStats extends RegisterBreakdown {
  // total - active - dissolved: every other Companies House status (liquidation, administration, ...).
  other: number;
}

export type PublicSiteStats =
  // dataAsOf: when the newest completed Companies House synchronisation finished, or null when that cannot be established.
  | { state: "ok"; register: PublicRegisterStats; dataAsOf: Date | null }
  // The database answered but holds no real companies: show nothing rather than "0 companies".
  | { state: "empty" }
  // The database could not be queried: show nothing rather than a stale or invented number.
  | { state: "unavailable" };

export interface PublicStatsDeps {
  getRegister: () => Promise<RegisterBreakdown>;
  getFreshness: () => Promise<DataFreshness>;
}

// getDataFreshness() falls back to the filing-stream or daily-update timestamp when no data synchronisation has ever run.
// Those show a job is alive, not that company data was updated, so they must not be presented as "data synced". A date is
// trusted only when there is evidence of a real sync: a loaded monthly snapshot or a covered new-registrations day.
export function trustedDataAsOf(f: DataFreshness): Date | null {
  return f.lastUpdated && (f.bulkSnapshot || f.registrationsThrough) ? f.lastUpdated : null;
}

export function createPublicSiteStatsLoader(deps: PublicStatsDeps): () => Promise<PublicSiteStats> {
  let inflight: Promise<PublicSiteStats> | null = null;

  async function load(): Promise<PublicSiteStats> {
    let register: RegisterBreakdown;
    try {
      register = await deps.getRegister();
    } catch (err) {
      log.error("register figures unavailable", { error: err instanceof Error ? err.message : String(err) });
      return { state: "unavailable" };
    }
    if (register.total <= 0) return { state: "empty" };

    let dataAsOf: Date | null = null;
    try {
      dataAsOf = trustedDataAsOf(await deps.getFreshness());
    } catch (err) {
      log.error("data freshness unavailable", { error: err instanceof Error ? err.message : String(err) });
    }

    const { total, active, dissolved, directorsConfirmed } = register;
    return { state: "ok", register: { total, active, dissolved, directorsConfirmed, other: Math.max(0, total - active - dissolved) }, dataAsOf };
  }

  // Concurrent callers share one load. Nothing is remembered once it settles, so a failure is never cached here
  // (getRegisterBreakdown itself only caches successful results).
  return () => {
    inflight ??= load().finally(() => {
      inflight = null;
    });
    return inflight;
  };
}

export const getPublicSiteStats = createPublicSiteStatsLoader({ getRegister: () => getRegisterBreakdown(), getFreshness: getDataFreshness });
