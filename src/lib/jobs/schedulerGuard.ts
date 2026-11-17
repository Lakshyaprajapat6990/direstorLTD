// Production database guard for the background scheduler (C7).
//
// The scheduler WRITES to whatever database DATABASE_URL names. The classic accident is a scheduler started with the wrong
// .env (a laptop file copied to the server, or a server started against the developer's database) and quietly filling or
// altering the wrong register. In production (NODE_ENV=production) the scheduler therefore refuses to start unless the
// operator has explicitly stated which database it is meant to use:
//
//   SCHEDULER_EXPECTED_DB_HOST   host name or IP exactly as it appears in DATABASE_URL
//   SCHEDULER_EXPECTED_DB_NAME   database name exactly as it appears in DATABASE_URL
//
// Outside production the expectation is optional, but if either variable is set it is enforced. This keeps the existing local
// supervisors (which do not set NODE_ENV) working unchanged. Credentials are never read into, or printed from, this module.

export interface DbTarget {
  host: string;
  port: string;
  database: string;
}

export interface GuardResult {
  ok: boolean;
  // host:port/database - never includes the user name or password.
  target: string;
  reason?: string;
}

export function describeDatabaseUrl(url: string | undefined): DbTarget | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!/^postgres(ql)?:$/.test(u.protocol)) return null;
    return {
      host: u.hostname.toLowerCase().replace(/^\[|\]$/g, ""),
      port: u.port || "5432",
      database: decodeURIComponent(u.pathname.replace(/^\//, "")).toLowerCase(),
    };
  } catch {
    return null;
  }
}

export function evaluateSchedulerDbGuard(env: Record<string, string | undefined> = process.env): GuardResult {
  const target = describeDatabaseUrl(env.DATABASE_URL);
  if (!target) {
    return { ok: false, target: "(unreadable DATABASE_URL)", reason: "DATABASE_URL is missing or is not a postgresql:// URL." };
  }
  const label = `${target.host}:${target.port}/${target.database}`;
  const expectedHost = env.SCHEDULER_EXPECTED_DB_HOST?.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const expectedName = env.SCHEDULER_EXPECTED_DB_NAME?.trim().toLowerCase();
  const production = env.NODE_ENV === "production";

  if (production && (!expectedHost || !expectedName)) {
    return {
      ok: false,
      target: label,
      reason: "In production SCHEDULER_EXPECTED_DB_HOST and SCHEDULER_EXPECTED_DB_NAME must both be set, so the scheduler can prove it is connected to the intended database.",
    };
  }
  if (expectedHost && expectedHost !== target.host) {
    return { ok: false, target: label, reason: `DATABASE_URL host "${target.host}" does not match SCHEDULER_EXPECTED_DB_HOST.` };
  }
  if (expectedName && expectedName !== target.database) {
    return { ok: false, target: label, reason: `DATABASE_URL database "${target.database}" does not match SCHEDULER_EXPECTED_DB_NAME.` };
  }
  return { ok: true, target: label };
}
