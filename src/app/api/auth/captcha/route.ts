import { NextResponse } from "next/server";
import { captchaIssueBlocked, issueChallenge } from "@/lib/auth/captcha";
import { clientIp } from "@/lib/auth/login-throttle";

// Issues a numeric CAPTCHA challenge for registration: a signed ticket and the image of the number. The answer is never in the
// response. Not cacheable, and rate limited (see captcha.ts).
export async function GET(request: Request) {
  const gate = await captchaIssueBlocked(clientIp(request));
  if (gate.blocked) {
    return NextResponse.json({ error: "Too many security checks requested. Please wait a few minutes and try again." }, { status: 429, headers: { "Retry-After": String(gate.retryAfterSeconds), "Cache-Control": "no-store" } });
  }
  const c = issueChallenge();
  return NextResponse.json({ ticket: c.ticket, image: c.image, expiresAt: c.expiresAt }, { headers: { "Cache-Control": "no-store" } });
}
