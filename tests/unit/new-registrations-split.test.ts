import { test } from "node:test";
import assert from "node:assert/strict";
import { readDayComplete, SPLIT_STATUSES, type DayFetcher } from "../../src/lib/companies-house/newRegistrations";

type Item = { company_number: string; company_name: string; company_status: string; company_type: string; date_of_creation: string };
const item = (n: number, status = "active", type = "ltd"): Item => ({ company_number: `T${String(n).padStart(7, "0")}`, company_name: `T ${n} LTD`, company_status: status, company_type: type, date_of_creation: "2026-01-05" });

// A fake register for ONE day: answers like the real search - at most `page` items per response, the true `hits` always.
function fakeRegister(all: Item[], page = 5000): { fetcher: DayFetcher; calls: { company_status?: string; company_type?: string }[] } {
  const calls: { company_status?: string; company_type?: string }[] = [];
  const fetcher: DayFetcher = async (_day, f) => {
    calls.push(f);
    const match = all.filter((i) => (!f.company_status || i.company_status === f.company_status) && (!f.company_type || i.company_type === f.company_type));
    return { items: match.slice(0, page), hits: match.length };
  };
  return { fetcher, calls };
}

test("a normal day is one request and no split", async () => {
  const { fetcher, calls } = fakeRegister(Array.from({ length: 3000 }, (_, i) => item(i)));
  const r = await readDayComplete("2026-01-05", fetcher);
  assert.equal(r.items.length, 3000);
  assert.equal(r.split, false);
  assert.equal(calls.length, 1);
});

test("a day above 5,000 is read completely by splitting on status, with no duplicates and a proven total", async () => {
  const all = [...Array.from({ length: 4000 }, (_, i) => item(i, "active")), ...Array.from({ length: 1500 }, (_, i) => item(10_000 + i, "dissolved"))];
  const { fetcher, calls } = fakeRegister(all);
  const r = await readDayComplete("2026-01-05", fetcher);
  assert.equal(r.split, true);
  assert.equal(r.hits, 5500);
  assert.equal(r.items.length, 5500);
  assert.equal(new Set(r.items.map((i) => i.company_number)).size, 5500);
  assert.equal(calls.length, 1 + SPLIT_STATUSES.length);
});

test("a status that is itself above 5,000 is split again by company type", async () => {
  const all = [...Array.from({ length: 3500 }, (_, i) => item(i, "active", "ltd")), ...Array.from({ length: 3000 }, (_, i) => item(20_000 + i, "active", "llp"))];
  const { fetcher } = fakeRegister(all);
  const r = await readDayComplete("2026-01-05", fetcher);
  assert.equal(r.items.length, 6500);
  assert.equal(r.hits, 6500);
});

test("coverage is never claimed when the slices do not add up to the day's total", async () => {
  // 6,000 rows of a status this code does not know about: the split by status accounts for 0 of them.
  const all = Array.from({ length: 6000 }, (_, i) => item(i, "some-future-status"));
  const { fetcher } = fakeRegister(all);
  await assert.rejects(() => readDayComplete("2026-01-05", fetcher), /not claiming coverage/);
});

test("a slice that is still too large after the type split fails instead of dropping companies", async () => {
  const all = Array.from({ length: 5200 }, (_, i) => item(i, "active", "ltd"));
  const { fetcher } = fakeRegister(all);
  // 'active' > 5,000, and 'ltd' within it is also > 5,000: cannot be read, so the day throws.
  await assert.rejects(() => readDayComplete("2026-01-05", fetcher), /still has 5200 matches/);
});
