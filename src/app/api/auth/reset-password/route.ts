import { NextResponse } from "next/server";
import { hashPassword } from "@/lib/auth/password";
import { validatePassword } from "@/lib/auth/password-policy";
import { completeReset, findResetSubject, looksLikeResetToken } from "@/lib/auth/password-reset";
import { resetBlocked } from "@/lib/auth/recovery-throttle";
import { clientIp } from "@/lib/auth/login-throttle";
import { isJsonContentType, isSameOrigin, readBoundedBytes } from "@/lib/site-content/request";
import { logActivity } from "@/lib/activity";
import { makeLogger } from "@/lib/log";

const log = makeLogger("recovery");
const fail = (status: number, body: Record<string, unknown>, headers?: Record<string, string>) => NextResponse.json(body, { status, headers });
const INVALID = { error: "This reset link is invalid or has expired. Request a new one.", code: "invalid_token" } as const;

// Sets a new password from an emailed token. The account comes ONLY from the token; the request names no user, email or role.
// Nothing changes until the token is valid, the password passes the same policy as registration, and the token has been spent
// in the same transaction that writes the new hash.
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return fail(403, { error: "Request not allowed." });
  if (!isJsonContentType(request)) return fail(415, { error: "Send the form as JSON." });
  const raw = await readBoundedBytes(request, 4 * 1024);
  if (!raw.ok) return raw.response;

  if (await resetBlocked(clientIp(request))) {
    return fail(429, { error: "Too many attempts. Please wait a few minutes and try again." }, { "Retry-After": "900" });
  }

  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw.bytes.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("shape");
    body = parsed as Record<string, unknown>;
  } catch {
    return fail(400, { error: "Check the form and try again." });
  }

  const token = body.token;
  if (!looksLikeResetToken(token)) return fail(400, INVALID);
  const subject = await findResetSubject(token);
  if (!subject) return fail(400, INVALID);

  const password = typeof body.password === "string" ? body.password : "";
  const confirm = typeof body.confirmPassword === "string" ? body.confirmPassword : "";
  const weakness = password ? validatePassword(password, { email: subject.email, name: subject.name }) : "Choose a password.";
  if (weakness) return fail(400, { error: "Check the highlighted fields.", fieldErrors: { password: weakness } });
  if (password !== confirm) return fail(400, { error: "Check the highlighted fields.", fieldErrors: { confirmPassword: "The passwords do not match." } });

  const passwordHash = await hashPassword(password);
  try {
    const done = await completeReset(token, passwordHash);
    if (!done.ok) return fail(400, INVALID);
    await logActivity({ userId: done.userId }, "password_reset");
  } catch (err) {
    log.error("recovery.reset_failed", { reason: err instanceof Error ? err.message.slice(0, 120) : "unknown" });
    return fail(400, INVALID);
  }
  return NextResponse.json({ ok: true });
}
