import { db } from "@/lib/db";

// Abuse limits for public registration, on the same DB-backed LoginAttempt table the sign-in throttle uses (so the limit is
// shared by every app instance and needs no new table). Unlike sign-in, EVERY attempt counts, not only failures: a bot
// creating real accounts never "fails". The window matches sign-in's 15 minutes because recordFailedLogin prunes anything
// older than twice that, so a longer window here would be silently shortened.
//   - per IP     : REGISTER_MAX_PER_IP / 15 min (default 10) - only when the IP is trusted (TRUST_PROXY=1), otherwise every
//                  visitor shares one "direct" bucket and a single bot could lock everyone out
//   - per email  : REGISTER_MAX_PER_EMAIL / 15 min (default 4) - stops hammering one address
//   - everything : REGISTER_MAX_TOTAL / 15 min (default 120) - a flood ceiling that holds even if IPs rotate or are spoofed
const WINDOW_MS = 15 * 60 * 1000;

function limit(envName: string, fallback: number): number {
  const n = Number(process.env[envName]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const ipKey = (ip: string) => `reg:ip:${ip}`;
const emailKey = (email: string) => `reg:email:${email}`;
const TOTAL_KEY = "reg:all";

// Records this attempt and reports whether it is over a limit. Recording first (rather than check-then-record) means a
// burst of parallel requests cannot all slip under the limit.
export async function registrationBlocked(email: string, ip: string): Promise<{ blocked: boolean; retryAfterSeconds: number }> {
  const trustIp = process.env.TRUST_PROXY === "1";
  const keys = [emailKey(email), TOTAL_KEY, ...(trustIp ? [ipKey(ip)] : [])];
  await db.loginAttempt.createMany({ data: keys.map((key) => ({ key })) });
  const since = new Date(Date.now() - WINDOW_MS);
  const countFor = (key: string) => db.loginAttempt.count({ where: { key, createdAt: { gt: since } } });
  const [byEmail, total, byIp] = await Promise.all([countFor(emailKey(email)), countFor(TOTAL_KEY), trustIp ? countFor(ipKey(ip)) : Promise.resolve(0)]);
  const blocked = byEmail > limit("REGISTER_MAX_PER_EMAIL", 4) || total > limit("REGISTER_MAX_TOTAL", 120) || byIp > limit("REGISTER_MAX_PER_IP", 10);
  return { blocked, retryAfterSeconds: blocked ? Math.ceil(WINDOW_MS / 1000) : 0 };
}
