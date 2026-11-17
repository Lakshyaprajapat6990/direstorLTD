import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// The server administrator's guide must not drift from the code: every command it names exists, every script it names exists, and every
// environment variable the scheduler / health code reads is listed in .env.example (so nobody has to read the source to configure it).

const root = path.resolve(__dirname, "..", "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const docs = read("docs/PRODUCTION_SCHEDULER.md");
const envExample = read(".env.example");
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

test("every `npm run <script>` named in the guide exists in package.json", () => {
  const named = [...docs.matchAll(/npm run (?:-s )?([a-z][a-z0-9:-]*)/g)].map((m) => m[1]);
  assert.ok(named.length >= 3, "the guide names the scheduler commands");
  for (const s of new Set(named)) assert.ok(pkg.scripts[s], `package.json has no script "${s}" (named in docs/PRODUCTION_SCHEDULER.md)`);
});

test("every scripts/ file named in the guide exists", () => {
  const named = [...docs.matchAll(/scripts[\\/][A-Za-z0-9_.-]+/g)].map((m) => m[0].replace(/\\/g, "/"));
  assert.ok(named.length >= 2);
  for (const f of new Set(named)) assert.ok(fs.existsSync(path.join(root, f)), `${f} is named in the guide but does not exist`);
});

test("the scripts the supervisors and the package scripts run really exist", () => {
  for (const f of ["scripts/scheduler.ts", "scripts/scheduler-status.ts", "scripts/load-env.ts", "scripts/run-production-scheduler.ps1", "scripts/run-production-scheduler.sh"]) {
    assert.ok(fs.existsSync(path.join(root, f)), f);
  }
  assert.match(pkg.scripts["jobs:scheduler"], /scripts\/scheduler\.ts/);
  assert.match(pkg.scripts["jobs:once"], /scripts\/scheduler\.ts --once/);
  assert.match(pkg.scripts["jobs:status"], /scripts\/scheduler-status\.ts/);
});

function envNamesRead(file: string): string[] {
  const src = read(file);
  const names = new Set<string>();
  for (const re of [/process\.env\.([A-Z][A-Z0-9_]{2,})/g, /\benv\.([A-Z][A-Z0-9_]{2,})/g, /\bnum\("([A-Z][A-Z0-9_]{2,})"/g, /\benvInt\(env, "([A-Z][A-Z0-9_]{2,})"/g]) {
    for (const m of src.matchAll(re)) names.add(m[1]);
  }
  return [...names];
}

test("every environment variable the scheduler, guard, refresh jobs, health and status code read is listed in .env.example", () => {
  // Variables that are not configuration an administrator sets (set by the OS / the supervisors / the test harness).
  const notConfig = new Set(["NODE_ENV", "LOG_FORMAT", "SCHEDULER_STOP_FILE", "SCHEDULER_LOG_DIR"]);
  const files = ["scripts/scheduler.ts", "scripts/scheduler-status.ts", "src/lib/jobs/dissolvedRefresh.ts", "src/lib/jobs/schedulerGuard.ts", "src/app/api/health/route.ts", "src/lib/jobs/health.ts"];
  const missing: string[] = [];
  for (const f of files) {
    for (const name of envNamesRead(f)) {
      if (notConfig.has(name)) continue;
      if (!new RegExp(`\\b${name}\\b`).test(envExample)) missing.push(`${name} (read in ${f})`);
    }
  }
  assert.deepEqual(missing, [], "add these to .env.example");
});

test("the guide documents every variable an administrator MUST set for production, and the .env.example lists them too", () => {
  for (const name of ["DATABASE_URL", "COMPANIES_HOUSE_API_KEY", "NODE_ENV", "SCHEDULER_EXPECTED_DB_HOST", "SCHEDULER_EXPECTED_DB_NAME", "SCHEDULER_EXPECTED"]) {
    assert.match(docs, new RegExp(`\\b${name}\\b`), `${name} missing from the guide`);
    assert.match(envExample, new RegExp(`\\b${name}\\b`), `${name} missing from .env.example`);
  }
});

test("the guide never assumes the server's operating system", () => {
  assert.match(docs, /operating system/i);
  assert.match(docs, /\.ps1/);
  assert.match(docs, /\.sh/);
});

test(".env.example holds no real-looking secret values", () => {
  for (const line of envExample.split(/\r?\n/)) {
    const m = /^\s*#?\s*(?:[A-Z_]*(?:KEY|SECRET|PASSWORD|PASS|TOKEN)[A-Z_]*)\s*=\s*"?([^"#\s]+)"?/.exec(line);
    if (m) assert.ok(m[1].length < 12 || /^(change|your|example|xxx|\.\.\.|placeholder)/i.test(m[1]), `looks like a real secret: ${line.slice(0, 40)}...`);
  }
});
