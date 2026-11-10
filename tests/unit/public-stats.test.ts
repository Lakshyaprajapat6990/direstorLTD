import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicSiteStatsLoader, trustedDataAsOf, type PublicStatsDeps } from "../../src/lib/data/public-stats";
import type { DataFreshness } from "../../src/lib/data/freshness";

const REGISTER = { total: 1000, active: 900, dissolved: 5, directorsConfirmed: 40 };
const SYNCED: DataFreshness = { lastUpdated: new Date("2026-10-12T12:15:18Z"), registrationsThrough: "2026-10-12", bulkSnapshot: "2026-09-01" };

function deps(over: Partial<PublicStatsDeps> = {}): PublicStatsDeps {
  return { getRegister: async () => REGISTER, getFreshness: async () => SYNCED, ...over };
}

test("figures are exactly the dashboard's register breakdown, plus the derived 'other' count", async () => {
  const s = await createPublicSiteStatsLoader(deps())();
  assert.equal(s.state, "ok");
  if (s.state !== "ok") return;
  assert.deepEqual(s.register, { ...REGISTER, other: 95 });
  assert.deepEqual(s.dataAsOf, SYNCED.lastUpdated);
});

test("only the approved aggregate fields are exposed", async () => {
  const s = await createPublicSiteStatsLoader(deps({ getRegister: async () => ({ ...REGISTER, secret: "x" }) as never }))();
  assert.equal(s.state, "ok");
  if (s.state !== "ok") return;
  assert.deepEqual(Object.keys(s).sort(), ["dataAsOf", "register", "state"]);
  assert.deepEqual(Object.keys(s.register).sort(), ["active", "directorsConfirmed", "dissolved", "other", "total"]);
});

test("an empty register is 'empty', never a zero or a made-up number", async () => {
  const s = await createPublicSiteStatsLoader(deps({ getRegister: async () => ({ total: 0, active: 0, dissolved: 0, directorsConfirmed: 0 }) }))();
  assert.deepEqual(s, { state: "empty" });
});

test("a database failure is 'unavailable' (no figures), and the failure is not remembered", async () => {
  let fail = true;
  const load = createPublicSiteStatsLoader(
    deps({
      getRegister: async () => {
        if (fail) throw new Error("connection refused");
        return REGISTER;
      },
    })
  );
  assert.deepEqual(await load(), { state: "unavailable" });
  fail = false;
  assert.equal((await load()).state, "ok");
});

test("a freshness failure keeps the figures and reports the date as unknown", async () => {
  const s = await createPublicSiteStatsLoader(
    deps({
      getFreshness: async () => {
        throw new Error("boom");
      },
    })
  )();
  assert.equal(s.state, "ok");
  if (s.state === "ok") assert.equal(s.dataAsOf, null);
});

test("a date is only trusted when a real data sync is evidenced", () => {
  assert.deepEqual(trustedDataAsOf(SYNCED), SYNCED.lastUpdated);
  assert.deepEqual(trustedDataAsOf({ ...SYNCED, bulkSnapshot: null }), SYNCED.lastUpdated); // new-registrations coverage is enough
  assert.deepEqual(trustedDataAsOf({ ...SYNCED, registrationsThrough: null }), SYNCED.lastUpdated); // so is a loaded monthly snapshot
  // getDataFreshness falls back to the stream / daily-update timestamp when nothing was ever synced: that is not a data date.
  assert.equal(trustedDataAsOf({ lastUpdated: new Date(), registrationsThrough: null, bulkSnapshot: null }), null);
  assert.equal(trustedDataAsOf({ lastUpdated: null, registrationsThrough: "2026-10-12", bulkSnapshot: "2026-09-01" }), null);
});

test("concurrent callers share one load; the next call after it settles loads again", async () => {
  let registerCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const load = createPublicSiteStatsLoader(
    deps({
      getRegister: async () => {
        registerCalls++;
        await gate;
        return REGISTER;
      },
    })
  );
  const [a, b, c] = [load(), load(), load()];
  assert.equal(a, b);
  assert.equal(b, c);
  release();
  assert.equal((await a).state, "ok");
  assert.equal(registerCalls, 1);
  await load();
  assert.equal(registerCalls, 2);
});
