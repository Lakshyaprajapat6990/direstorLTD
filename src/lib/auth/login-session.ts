import { db } from "@/lib/db";
import { createSessionToken, setSessionCookie } from "@/lib/auth/session";
import { clearFailedLogins } from "@/lib/auth/login-throttle";
import { logActivity } from "@/lib/activity";
import type { UserRole } from "@/lib/types";

// The one place a sign-in becomes a session. Reached only after the password has been verified.
export async function startSession(
  request: Request,
  user: { id: string; email: string; name: string; role: string },
  ip: string,
  meta?: Record<string, unknown>
) {
  const now = new Date();
  const [session] = await db.$transaction([
    db.userSession.create({
      data: { userId: user.id, startedAt: now, lastActivityAt: now, userAgent: request.headers.get("user-agent")?.slice(0, 200) ?? null },
      select: { id: true },
    }),
    db.user.update({ where: { id: user.id }, data: { lastLoginAt: now } }),
  ]);
  const token = await createSessionToken({ userId: user.id, email: user.email, name: user.name, role: user.role as UserRole, sid: session.id });
  await setSessionCookie(token);
  await clearFailedLogins(user.email.toLowerCase(), ip);
  await logActivity({ userId: user.id, sid: session.id }, "login", meta ? { meta } : {});
}
