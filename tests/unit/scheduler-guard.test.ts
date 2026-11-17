import { test } from "node:test";
import assert from "node:assert/strict";
import { describeDatabaseUrl, evaluateSchedulerDbGuard } from "../../src/lib/jobs/schedulerGuard";

const URL_ = "postgresql://appuser:s3cret@db.internal:5432/director_ltd?schema=public";

test("production without an explicit expectation is refused", () => {
  const r = evaluateSchedulerDbGuard({ NODE_ENV: "production", DATABASE_URL: URL_ });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /SCHEDULER_EXPECTED_DB_HOST and SCHEDULER_EXPECTED_DB_NAME/);
});

test("production with only one of the two expectations is refused", () => {
  assert.equal(evaluateSchedulerDbGuard({ NODE_ENV: "production", DATABASE_URL: URL_, SCHEDULER_EXPECTED_DB_HOST: "db.internal" }).ok, false);
  assert.equal(evaluateSchedulerDbGuard({ NODE_ENV: "production", DATABASE_URL: URL_, SCHEDULER_EXPECTED_DB_NAME: "director_ltd" }).ok, false);
});

test("production with matching expectations is accepted (case-insensitive)", () => {
  const r = evaluateSchedulerDbGuard({ NODE_ENV: "production", DATABASE_URL: URL_, SCHEDULER_EXPECTED_DB_HOST: "DB.internal", SCHEDULER_EXPECTED_DB_NAME: "Director_LTD" });
  assert.equal(r.ok, true);
  assert.equal(r.target, "db.internal:5432/director_ltd");
});

test("a wrong host or database name is refused, even outside production", () => {
  assert.equal(evaluateSchedulerDbGuard({ DATABASE_URL: URL_, SCHEDULER_EXPECTED_DB_HOST: "127.0.0.1" }).ok, false);
  assert.equal(evaluateSchedulerDbGuard({ DATABASE_URL: URL_, SCHEDULER_EXPECTED_DB_NAME: "director_scratch" }).ok, false);
  assert.equal(
    evaluateSchedulerDbGuard({ NODE_ENV: "production", DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/director_ltd", SCHEDULER_EXPECTED_DB_HOST: "db.internal", SCHEDULER_EXPECTED_DB_NAME: "director_ltd" }).ok,
    false
  );
});

test("outside production with no expectation the existing local setups keep working", () => {
  assert.equal(evaluateSchedulerDbGuard({ DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/director_ltd" }).ok, true);
});

test("a missing or non-postgres DATABASE_URL is refused", () => {
  assert.equal(evaluateSchedulerDbGuard({}).ok, false);
  assert.equal(evaluateSchedulerDbGuard({ DATABASE_URL: "mysql://u:p@h/db" }).ok, false);
  assert.equal(evaluateSchedulerDbGuard({ DATABASE_URL: "not a url" }).ok, false);
});

test("credentials never appear in the target or the reason", () => {
  for (const env of [
    { NODE_ENV: "production", DATABASE_URL: URL_ },
    { DATABASE_URL: URL_, SCHEDULER_EXPECTED_DB_HOST: "other" },
    { NODE_ENV: "production", DATABASE_URL: URL_, SCHEDULER_EXPECTED_DB_HOST: "db.internal", SCHEDULER_EXPECTED_DB_NAME: "director_ltd" },
  ]) {
    const r = evaluateSchedulerDbGuard(env);
    const text = `${r.target} ${r.reason ?? ""}`;
    assert.ok(!text.includes("s3cret"));
    assert.ok(!text.includes("appuser"));
  }
});

test("describeDatabaseUrl handles IPv6 literals and default ports", () => {
  assert.deepEqual(describeDatabaseUrl("postgresql://u:p@[::1]/d"), { host: "::1", port: "5432", database: "d" });
});
