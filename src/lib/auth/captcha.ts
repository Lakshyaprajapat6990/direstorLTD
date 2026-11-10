import { createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { getAuthSecret } from "@/lib/auth/session";

// Numeric CAPTCHA for public registration. The server draws a random number, shows it only as a distorted image, and hands the
// browser a signed ticket {id, expiry} that does NOT contain the answer. The ticket's signature is an HMAC over id, expiry and the
// answer under a key derived from AUTH_SECRET, so the server can check a submitted answer without storing anything, and nobody can
// forge a ticket or read the answer out of it.
//   - expires after CAPTCHA_TTL_MS
//   - single use: the first attempt with a ticket burns it, right or wrong (so one ticket allows exactly one guess); the burn is a
//     row on the existing LoginAttempt table, recorded BEFORE it is counted so two parallel attempts cannot both pass
//   - issuing is rate limited (captchaIssueBlocked) and every registration attempt is already rate limited (register-throttle)
export const CAPTCHA_LENGTH = 5;
export const CAPTCHA_TTL_MS = 5 * 60 * 1000;
const MAX_TICKET_LENGTH = 200;
const ISSUE_WINDOW_MS = 15 * 60 * 1000;

export type CaptchaFailure = "missing" | "invalid" | "expired" | "used";
export const CAPTCHA_MESSAGES: Record<CaptchaFailure, string> = {
  missing: "Please type the number shown in the security check.",
  invalid: "That number is not right. Please try again with the new one shown.",
  expired: "The security check expired. Please type the number from the new one.",
  used: "That security check was already used. Please type the number from the new one.",
};

const key = () => Buffer.from(hkdfSync("sha256", getAuthSecret(), "director.ltd/captcha", "numeric-captcha-v1", 32));
const sign = (id: string, exp: number, answer: string) => createHmac("sha256", key()).update(`${id}.${exp}.${answer}`).digest("base64url");

// Pure: draws a challenge and returns the answer alongside the public parts. The API route never sends `answer` to the browser;
// the integration tests use it to play the part of a person reading the image.
export function mintChallenge(now = Date.now()): { ticket: string; answer: string; expiresAt: number } {
  let answer = "";
  for (let i = 0; i < CAPTCHA_LENGTH; i++) answer += String(randomInt(i === 0 ? 1 : 0, 10));
  const id = randomBytes(12).toString("base64url");
  const exp = now + CAPTCHA_TTL_MS;
  return { ticket: `${id}.${exp}.${sign(id, exp, answer)}`, answer, expiresAt: exp };
}

// The digits as an SVG: each one rotated, shifted and slanted a little, over noise lines and dots. Text is not in the page's DOM,
// so it cannot simply be read from the HTML.
export function renderChallengeSvg(answer: string): string {
  const w = 190;
  const h = 56;
  const r = (min: number, max: number) => min + (randomInt(0, 10001) / 10000) * (max - min);
  const colours = ["#0f2a5c", "#1d4ed8", "#1e3a8a", "#312e81", "#0f172a"];
  let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" rx="8" fill="#eef2ff"/>`;
  for (let i = 0; i < 6; i++) out += `<path d="M${r(0, w).toFixed(1)} ${r(0, h).toFixed(1)} Q${r(0, w).toFixed(1)} ${r(0, h).toFixed(1)} ${r(0, w).toFixed(1)} ${r(0, h).toFixed(1)}" stroke="${colours[i % 5]}" stroke-opacity="0.35" stroke-width="1.4" fill="none"/>`;
  for (let i = 0; i < 28; i++) out += `<circle cx="${r(0, w).toFixed(1)}" cy="${r(0, h).toFixed(1)}" r="${r(0.6, 1.6).toFixed(1)}" fill="#1d4ed8" fill-opacity="0.35"/>`;
  const step = (w - 28) / answer.length;
  [...answer].forEach((d, i) => {
    const x = 18 + i * step + r(-2, 2);
    const y = 38 + r(-5, 5);
    out += `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="Verdana,Arial,sans-serif" font-size="${r(28, 34).toFixed(0)}" font-weight="700" fill="${colours[randomInt(0, colours.length)]}" transform="rotate(${r(-18, 18).toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)}) skewX(${r(-12, 12).toFixed(1)})">${d}</text>`;
  });
  return `${out}</svg>`;
}

export function issueChallenge(now = Date.now()): { ticket: string; image: string; expiresAt: number } {
  const c = mintChallenge(now);
  return { ticket: c.ticket, expiresAt: c.expiresAt, image: `data:image/svg+xml;base64,${Buffer.from(renderChallengeSvg(c.answer)).toString("base64")}` };
}

// Issuing a challenge is free for the visitor but not for us, and refresh makes it repeatable: limit it per IP (when the IP is
// trusted, see TRUST_PROXY) and overall, on the same DB-backed table as the sign-in and registration limits.
export async function captchaIssueBlocked(ip: string): Promise<{ blocked: boolean; retryAfterSeconds: number }> {
  const trustIp = process.env.TRUST_PROXY === "1";
  const max = (name: string, fallback: number) => (Number.isFinite(Number(process.env[name])) && Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback);
  const keys = ["captcha:all", ...(trustIp ? [`captcha:ip:${ip}`] : [])];
  await db.loginAttempt.createMany({ data: keys.map((k) => ({ key: k })) });
  // Opportunistic pruning of this feature's own rows (a ticket is dead after 5 minutes, the window after 15).
  await db.loginAttempt.deleteMany({ where: { key: { startsWith: "captcha:" }, createdAt: { lt: new Date(Date.now() - 2 * ISSUE_WINDOW_MS) } } });
  const since = new Date(Date.now() - ISSUE_WINDOW_MS);
  const count = (k: string) => db.loginAttempt.count({ where: { key: k, createdAt: { gt: since } } });
  const [all, byIp] = await Promise.all([count("captcha:all"), trustIp ? count(`captcha:ip:${ip}`) : Promise.resolve(0)]);
  const blocked = all > max("CAPTCHA_MAX_TOTAL", 600) || byIp > max("CAPTCHA_MAX_PER_IP", 40);
  return { blocked, retryAfterSeconds: blocked ? Math.ceil(ISSUE_WINDOW_MS / 1000) : 0 };
}

const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function verifyChallenge(ticket: unknown, answer: unknown, now = Date.now()): Promise<{ ok: true } | { ok: false; reason: CaptchaFailure }> {
  if (typeof ticket !== "string" || !ticket.trim() || typeof answer !== "string" || !answer.trim()) return { ok: false, reason: "missing" };
  const given = answer.replace(/\s+/g, "");
  const parts = ticket.length <= MAX_TICKET_LENGTH ? ticket.split(".") : [];
  if (parts.length !== 3 || !/^\d{1,16}$/.test(parts[1])) return { ok: false, reason: "invalid" };
  const [id, expRaw, sig] = parts;
  const exp = Number(expRaw);
  if (now > exp) {
    // Reported as "expired" only when the ticket is genuine (its signature matches the submitted answer); anything else is just wrong.
    return /^[0-9]{1,16}$/.test(given) && equal(sign(id, exp, given), sig) ? { ok: false, reason: "expired" } : { ok: false, reason: "invalid" };
  }
  // Burn the ticket first (any answer, right or wrong), then see whether this attempt is the only one.
  const usedKey = `captcha:used:${id}`;
  await db.loginAttempt.create({ data: { key: usedKey } });
  const uses = await db.loginAttempt.count({ where: { key: usedKey } });
  if (uses > 1) return { ok: false, reason: "used" };
  if (!/^\d{1,16}$/.test(given) || !equal(sign(id, exp, given), sig)) return { ok: false, reason: "invalid" };
  return { ok: true };
}
