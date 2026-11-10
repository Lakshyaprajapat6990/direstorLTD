import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";

// Password recovery tokens. The raw secret exists only in the email sent to the account owner; the database holds its SHA-256
// hash (the secret is 256 random bits, so a fast hash is appropriate and a leaked table cannot be reversed or used).

export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
const RAW_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

export const hashResetToken = (raw: string) => createHash("sha256").update(raw).digest("hex");
export const looksLikeResetToken = (v: unknown): v is string => typeof v === "string" && RAW_TOKEN_RE.test(v);

// Issues a fresh token for an ACTIVE account and withdraws any earlier unused one (only the newest emailed link works).
// Returns the raw secret, or null when the account may not recover (missing or deactivated).
export async function issueResetToken(userId: string): Promise<string | null> {
  const raw = randomBytes(32).toString("base64url");
  const now = new Date();
  return db.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { active: true } });
    if (!user?.active) return null;
    await tx.passwordResetToken.deleteMany({ where: { OR: [{ userId, usedAt: null }, { expiresAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } }] } });
    await tx.passwordResetToken.create({ data: { userId, tokenHash: hashResetToken(raw), expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MS) } });
    return raw;
  });
}

export async function discardResetToken(raw: string): Promise<void> {
  await db.passwordResetToken.deleteMany({ where: { tokenHash: hashResetToken(raw) } });
}

export interface ResetSubject {
  userId: string;
  email: string;
  name: string;
}

// Who a token belongs to, if it is well formed, unexpired, unused and the account is still active. The account is derived ONLY
// from the token: nothing the caller sends names an account.
export async function findResetSubject(raw: unknown): Promise<ResetSubject | null> {
  if (!looksLikeResetToken(raw)) return null;
  const row = await db.passwordResetToken.findUnique({
    where: { tokenHash: hashResetToken(raw) },
    select: { usedAt: true, expiresAt: true, user: { select: { id: true, email: true, name: true, active: true } } },
  });
  if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now() || !row.user.active) return null;
  return { userId: row.user.id, email: row.user.email, name: row.user.name };
}

// Spends the token and sets the new password in ONE transaction. The conditional UPDATE is the single-use guard: of any number
// of simultaneous attempts exactly one changes a row. Every other open session of the account is ended (so whoever knew the old
// password is signed out); role, permissions, active flag and team are never touched.
export async function completeReset(raw: string, passwordHash: string): Promise<{ ok: true; userId: string } | { ok: false }> {
  const tokenHash = hashResetToken(raw);
  return db.$transaction(async (tx) => {
    const now = new Date();
    const spent = await tx.passwordResetToken.updateMany({ where: { tokenHash, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
    if (spent.count !== 1) return { ok: false as const };
    const token = await tx.passwordResetToken.findUniqueOrThrow({ where: { tokenHash }, select: { userId: true } });
    const user = await tx.user.updateMany({ where: { id: token.userId, active: true }, data: { passwordHash } });
    if (user.count !== 1) throw new Error("account no longer active"); // rolls the whole transaction back, token included
    await tx.userSession.updateMany({ where: { userId: token.userId, endedAt: null }, data: { endedAt: now, endReason: "password_reset" } });
    await tx.passwordResetToken.deleteMany({ where: { userId: token.userId, usedAt: null } });
    return { ok: true as const, userId: token.userId };
  });
}
