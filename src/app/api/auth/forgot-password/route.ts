import { NextResponse, after } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { appBaseUrl, isMailConfigured, sendMail } from "@/lib/mail";
import { RESET_TOKEN_TTL_MS, discardResetToken, issueResetToken } from "@/lib/auth/password-reset";
import { forgotBlocked } from "@/lib/auth/recovery-throttle";
import { clientIp } from "@/lib/auth/login-throttle";
import { normaliseEmail } from "@/lib/auth/registration";
import { isJsonContentType, isSameOrigin, readBoundedBytes } from "@/lib/site-content/request";
import { logActivity } from "@/lib/activity";
import { makeLogger } from "@/lib/log";

const log = makeLogger("recovery");
const bodySchema = z.object({ email: z.string().max(254).email() });

const fail = (status: number, body: Record<string, unknown>, headers?: Record<string, string>) => NextResponse.json(body, { status, headers });

// The same answer for every well-formed address, registered or not. The account lookup, token creation and email all happen
// AFTER the response is sent, so the response time carries no information either.
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return fail(403, { error: "Request not allowed." });
  if (!isJsonContentType(request)) return fail(415, { error: "Send the form as JSON." });
  const raw = await readBoundedBytes(request, 2 * 1024);
  if (!raw.ok) return raw.response;

  let json: unknown;
  try {
    json = JSON.parse(raw.bytes.toString("utf8"));
  } catch {
    return fail(400, { error: "Enter a valid email address." });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return fail(400, { error: "Enter a valid email address." });
  const email = normaliseEmail(parsed.data.email);

  // Without a mail server and a configured site address nothing can be sent. Say so plainly rather than claiming an email left.
  const base = appBaseUrl();
  if (!isMailConfigured() || !base) {
    return fail(503, { error: "Password recovery by email is not set up on this system. Please contact your administrator." });
  }

  if (await forgotBlocked(email, clientIp(request))) {
    return fail(429, { error: "Too many requests. Please wait a few minutes and try again." }, { "Retry-After": "900" });
  }

  after(async () => {
    let issued: string | null = null;
    try {
      const user = await db.user.findUnique({ where: { email }, select: { id: true, active: true } });
      if (!user?.active) return;
      issued = await issueResetToken(user.id);
      if (!issued) return;
      const link = `${base}/reset-password#token=${issued}`;
      const minutes = Math.round(RESET_TOKEN_TTL_MS / 60_000);
      await sendMail({
        to: email,
        subject: "Reset your DIRECTOR.LTD password",
        text: `Someone asked to reset the password for this DIRECTOR.LTD account.\n\nTo choose a new password, open this link within ${minutes} minutes:\n${link}\n\nThe link works once. If you did not ask for this, ignore this email: your password has not changed.\n\nDIRECTOR.LTD will never ask you to email your password.`,
        html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;color:#0f172a"><h2 style="color:#1e1b4b">Reset your password</h2><p>Someone asked to reset the password for this DIRECTOR.LTD account.</p><p><a href="${link}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">Choose a new password</a></p><p style="font-size:13px;color:#475569">This link works once and expires in ${minutes} minutes. If the button does not work, copy this address into your browser:<br><span style="word-break:break-all">${link}</span></p><p style="font-size:13px;color:#475569">If you did not ask for this, ignore this email: your password has not changed. DIRECTOR.LTD will never ask you to email your password.</p></div>`,
      });
      await logActivity({ userId: user.id }, "password_reset_requested");
    } catch (err) {
      // Never log the token, the address or the link. A token that could not be mailed is withdrawn.
      // The SMTP error code (EAUTH = login refused, ECONNECTION / ETIMEDOUT = server unreachable ...) tells an administrator what
      // to fix. Never the token, the address, the link or the password.
      log.error("recovery.mail_failed", { code: (err as { code?: string }).code ?? "ERROR", reason: err instanceof Error ? err.message.slice(0, 120) : "unknown" });
      if (issued) await discardResetToken(issued).catch(() => undefined);
    }
  });

  return NextResponse.json({ ok: true });
}
