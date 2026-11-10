import { db } from "@/lib/db";

// Abuse limits for password recovery, on the same DB-backed LoginAttempt table as sign-in and registration (shared by every app
// instance). Every request counts, whether or not an account exists, so the limits themselves reveal nothing. The 15 minute
// window matches the sign-in throttle (which prunes rows older than 30 minutes).
//   request a link : per email  FORGOT_MAX_PER_EMAIL / 15 min (default 3)
//                    per IP     FORGOT_MAX_PER_IP    / 15 min (default 10, only when TRUST_PROXY=1)
//                    everything FORGOT_MAX_TOTAL     / 15 min (default 60)  - also bounds how much mail the app can be made to send
//   use a link     : per IP     RESET_MAX_PER_IP     / 15 min (default 20, only when TRUST_PROXY=1)
//                    everything RESET_MAX_TOTAL      / 15 min (default 200)
const WINDOW_MS = 15 * 60 * 1000;

function limit(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Records the attempt first (so parallel bursts cannot all slip under the limit), then reports whether any limit is exceeded.
async function over(checks: { key: string; max: number }[]): Promise<boolean> {
  await db.loginAttempt.createMany({ data: checks.map((c) => ({ key: c.key })) });
  const since = new Date(Date.now() - WINDOW_MS);
  const counts = await Promise.all(checks.map((c) => db.loginAttempt.count({ where: { key: c.key, createdAt: { gt: since } } })));
  return checks.some((c, i) => counts[i] > c.max);
}

const trustIp = () => process.env.TRUST_PROXY === "1";

export function forgotBlocked(email: string, ip: string): Promise<boolean> {
  return over([
    { key: `fp:email:${email}`, max: limit("FORGOT_MAX_PER_EMAIL", 3) },
    { key: "fp:all", max: limit("FORGOT_MAX_TOTAL", 60) },
    ...(trustIp() ? [{ key: `fp:ip:${ip}`, max: limit("FORGOT_MAX_PER_IP", 10) }] : []),
  ]);
}

export function resetBlocked(ip: string): Promise<boolean> {
  return over([
    { key: "pr:all", max: limit("RESET_MAX_TOTAL", 200) },
    ...(trustIp() ? [{ key: `pr:ip:${ip}`, max: limit("RESET_MAX_PER_IP", 20) }] : []),
  ]);
}
