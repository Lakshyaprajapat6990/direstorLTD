import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { validateRegistration } from "@/lib/auth/registration";
import { registrationBlocked } from "@/lib/auth/register-throttle";
import { clientIp } from "@/lib/auth/login-throttle";
import { isJsonContentType, isSameOrigin, readBoundedBytes } from "@/lib/site-content/request";
import { CAPTCHA_MESSAGES, verifyChallenge } from "@/lib/auth/captcha";
import { logActivity } from "@/lib/activity";
import { makeLogger } from "@/lib/log";

const log = makeLogger("register");

// Public customer self-registration. Creates a CUSTOMER account (no permissions, see src/lib/auth/permissions.ts) and nothing
// else: the role, permission list, active flag and supervisor are fixed here, never read from the request.
//
// A new address and an address that is already registered get the SAME response, so this endpoint cannot be used to find out
// who has an account. (No email is sent - none is configured - so the success text says what happens in both cases.)
const MAX_BODY_BYTES = 8 * 1024;

const fail = (status: number, body: Record<string, unknown>, headers?: Record<string, string>) => NextResponse.json(body, { status, headers });

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return fail(403, { error: "Request not allowed." });
  if (!isJsonContentType(request)) return fail(415, { error: "Send the form as JSON." });

  const raw = await readBoundedBytes(request, MAX_BODY_BYTES);
  if (!raw.ok) return raw.response;
  let body: unknown;
  try {
    body = JSON.parse(raw.bytes.toString("utf8"));
  } catch {
    return fail(400, { error: "Check the form and try again." });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return fail(400, { error: "Check the form and try again." });

  const parsed = validateRegistration(body as Record<string, unknown>);
  if (!parsed.ok) return fail(400, { error: "Check the highlighted fields.", fieldErrors: parsed.errors });
  const { name, email, password } = parsed.value;

  const gate = await registrationBlocked(email, clientIp(request));
  if (gate.blocked) {
    return fail(429, { error: "Too many registration attempts. Please wait a few minutes and try again." }, { "Retry-After": String(gate.retryAfterSeconds) });
  }

  // Numeric CAPTCHA, checked on the server after the rate limit and before the costly hash. A challenge works once (right or
  // wrong), so the form fetches a fresh one after every failed attempt.
  const human = await verifyChallenge((body as Record<string, unknown>).captchaToken, (body as Record<string, unknown>).captchaAnswer);
  if (!human.ok) return fail(400, { error: CAPTCHA_MESSAGES[human.reason], captcha: human.reason });

  // Hashed before the database is consulted, so a new and an already-registered address take the same time.
  const passwordHash = await hashPassword(password);

  try {
    // One INSERT: either the whole account exists or nothing does. The UNIQUE index on email is the real duplicate guard,
    // so two simultaneous registrations of one address cannot both succeed (no check-then-insert race).
    const user = await db.user.create({
      data: { name, email, passwordHash, role: "CUSTOMER", permissions: "[]", active: true },
      select: { id: true },
    });
    await logActivity({ userId: user.id }, "customer_registered");
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) {
      log.error("register.failed", { err: err instanceof Error ? err.message.slice(0, 200) : "unknown" });
      return fail(500, { error: "We could not create your account. Please try again." });
    }
    // Already registered: answered exactly like a success.
  }

  return NextResponse.json({ ok: true });
}
