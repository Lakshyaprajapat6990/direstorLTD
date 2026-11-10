import nodemailer from "nodemailer";

// The one place the application sends email (currently only password recovery). Plain SMTP, so any provider works (a hosting
// mailbox, Microsoft 365, Google Workspace, Amazon SES, Mailgun, ...). Every value comes from environment variables and is only
// ever read on the server; nothing here is returned to a browser or logged.
//
//   SMTP_HOST          required   e.g. smtp.example.com
//   SMTP_PORT          optional   default 587 (STARTTLS) - use 465 together with SMTP_SECURE=true for implicit TLS
//   SMTP_SECURE        optional   "true" = TLS from the first byte (port 465)
//   SMTP_REQUIRE_TLS   optional   default true: a plain connection is refused if the server cannot upgrade to TLS, so reset links
//                                 and the mailbox password never cross the network unencrypted. Set "false" only for a local sink.
//   SMTP_USER / SMTP_PASS  optional   mailbox credentials (both or neither)
//   MAIL_FROM          required   sender, e.g. "DIRECTOR.LTD <no-reply@your-domain>"
//
// Resend (HTTPS API, no extra package) is used instead of SMTP when RESEND_API_KEY is set:
//   RESEND_API_KEY     the API key. Server side only; never logged, returned or put in a URL.
//   EMAIL_FROM         sender, e.g. "DIRECTOR.LTD <no-reply@your-verified-domain>" (falls back to MAIL_FROM). With Resend's shared
//                      onboarding@resend.dev sender, Resend delivers only to the address that owns the Resend account.
//   APP_URL            public address of the site, used for the link in the email (falls back to APP_BASE_URL, then NEXTAUTH_URL)
//   RESEND_API_URL     optional override of https://api.resend.com (tests only)
//
// Without a usable provider (Resend, or SMTP_HOST + MAIL_FROM) nothing can be sent: isMailConfigured() is false and callers must
// say so, never pretend.

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  user?: string;
  pass?: string;
  from: string;
}

export function mailConfig(): MailConfig | null {
  const host = process.env.SMTP_HOST?.trim();
  const from = process.env.MAIL_FROM?.trim();
  if (!host || !from) return null;
  const port = Number(process.env.SMTP_PORT);
  const secure = process.env.SMTP_SECURE?.toLowerCase() === "true";
  const user = process.env.SMTP_USER?.trim() || undefined;
  const pass = process.env.SMTP_PASS || undefined;
  if (Boolean(user) !== Boolean(pass)) return null; // half a credential is a configuration error, not "no auth"
  return {
    host,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : secure ? 465 : 587,
    secure,
    requireTLS: process.env.SMTP_REQUIRE_TLS?.toLowerCase() !== "false",
    user,
    pass,
    from,
  };
}

interface ResendConfig {
  apiKey: string;
  from: string;
  apiUrl: string;
}

export function resendConfig(): ResendConfig | null {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = (process.env.EMAIL_FROM || process.env.MAIL_FROM || "").trim();
  if (!apiKey || !from || !/@/.test(from)) return null;
  return { apiKey, from, apiUrl: (process.env.RESEND_API_URL?.trim() || "https://api.resend.com").replace(/[/]+$/, "") };
}

export type MailProvider = "resend" | "smtp" | null;
export const mailProvider = (): MailProvider => (process.env.RESEND_API_KEY?.trim() ? (resendConfig() ? "resend" : null) : mailConfig() ? "smtp" : null);
export const isMailConfigured = () => mailProvider() !== null;

// Absolute base URL used to build links in emails. Taken from configuration, NEVER from the incoming request: a Host header an
// attacker controls could otherwise make the emailed reset link point at their server.
export function appBaseUrl(): string | null {
  const raw = (process.env.APP_URL || process.env.APP_BASE_URL || process.env.NEXTAUTH_URL || "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

// Plain-language list of what is wrong with the mail settings, by variable NAME only (never a value, so it is safe to print or
// log). Empty means the settings are usable. This is configuration validation, not proof the server accepts the login.
export function mailSettingsProblems(): string[] {
  const out: string[] = [];
  if (process.env.RESEND_API_KEY?.trim()) {
    const from = (process.env.EMAIL_FROM || process.env.MAIL_FROM || "").trim();
    if (!from) out.push("EMAIL_FROM is not set.");
    else if (!/@/.test(from)) out.push("EMAIL_FROM must contain an email address, e.g. DIRECTOR.LTD <no-reply@your-domain>.");
    if (!appBaseUrl()) out.push("APP_URL (or APP_BASE_URL / NEXTAUTH_URL) is not set to a valid http(s) address.");
    return out;
  }
  const host = process.env.SMTP_HOST?.trim();
  const from = process.env.MAIL_FROM?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS;
  const portRaw = process.env.SMTP_PORT?.trim();
  const secure = process.env.SMTP_SECURE?.toLowerCase() === "true";
  if (!host) out.push("SMTP_HOST is not set.");
  if (!from) out.push("MAIL_FROM is not set.");
  if (from && !/@/.test(from)) out.push("MAIL_FROM must contain an email address, e.g. DIRECTOR.LTD <no-reply@your-domain>.");
  if (Boolean(user) !== Boolean(pass)) out.push("SMTP_USER and SMTP_PASS must be set together (or both left empty).");
  if (portRaw) {
    const port = Number(portRaw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) out.push("SMTP_PORT must be a whole number between 1 and 65535.");
    else if (port === 465 && !secure) out.push("Port 465 uses TLS from the first byte: set SMTP_SECURE=true.");
    else if (port === 587 && secure) out.push("Port 587 uses STARTTLS: set SMTP_SECURE=false (SMTP_SECURE=true is for port 465).");
  }
  if (!appBaseUrl()) out.push("APP_BASE_URL (or NEXTAUTH_URL) is not set to a valid http(s) address.");
  return out;
}

export type MailCheck = { ok: true } | { ok: false; code: string; message: string };

// Opens a connection to the configured SMTP server, negotiates TLS and logs in (when credentials are set), then closes it.
// Sends NO email. Used by `npm run mail:check`. Error text comes from the SMTP server / network and never includes the password.
export async function verifyMailTransport(): Promise<MailCheck> {
  const rc = resendConfig();
  if (rc) {
    // A full-access key can list domains; a "sending access" key cannot and is answered 401 restricted_api_key, which still
    // proves the key itself is valid. Anything else (invalid_api_key, network error) fails.
    try {
      const res = await fetch(`${rc.apiUrl}/domains`, { headers: { Authorization: `Bearer ${rc.apiKey}` }, signal: AbortSignal.timeout(15_000) });
      const body = (await res.json().catch(() => ({}))) as { name?: string; message?: string };
      if (res.ok || body.name === "restricted_api_key") return { ok: true };
      return { ok: false, code: body.name ?? `HTTP_${res.status}`, message: (body.message ?? "Resend refused the request").slice(0, 300) };
    } catch (err) {
      return { ok: false, code: "ECONNECTION", message: err instanceof Error ? err.message.slice(0, 300) : "network error" };
    }
  }
  const cfg = mailConfig();
  if (!cfg) return { ok: false, code: "NOT_CONFIGURED", message: "mail is not configured" };
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    requireTLS: cfg.requireTLS && !cfg.secure,
    ...(cfg.user ? { auth: { user: cfg.user, pass: cfg.pass } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  try {
    await transport.verify();
    return { ok: true };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { ok: false, code: e.code ?? "ERROR", message: (e.message ?? "unknown error").slice(0, 300) };
  } finally {
    transport.close();
  }
}

// Throws if the message cannot be handed to the SMTP server. A resolved promise means the server ACCEPTED the message for
// delivery; it does not prove the recipient's mailbox received it.
export async function sendMail(message: MailMessage): Promise<void> {
  const rc = resendConfig();
  if (rc) return sendWithResend(rc, message);
  const cfg = mailConfig();
  if (!cfg) throw new Error("mail is not configured");
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    requireTLS: cfg.requireTLS && !cfg.secure,
    ...(cfg.user ? { auth: { user: cfg.user, pass: cfg.pass } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  try {
    const info = await transport.sendMail({ from: cfg.from, to: message.to, subject: message.subject, text: message.text, html: message.html });
    if (!info.accepted?.length) throw new Error("the mail server did not accept the recipient");
  } finally {
    transport.close();
  }
}

// Resend's REST API. 200 + an id means Resend ACCEPTED the message; it does not prove the mailbox received it. The error carries
// Resend's error name as `code` (e.g. validation_error, invalid_api_key) and its message, never the key.
async function sendWithResend(rc: ResendConfig, message: MailMessage): Promise<void> {
  const res = await fetch(`${rc.apiUrl}/emails`, {
    method: "POST",
    headers: { Authorization: `Bearer ${rc.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: rc.from, to: [message.to], subject: message.subject, text: message.text, html: message.html }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; name?: string; message?: string };
  if (!res.ok || !body.id) {
    const err = new Error(`Resend ${res.status}: ${(body.message ?? "request failed").slice(0, 200)}`) as Error & { code?: string };
    err.code = body.name ?? `HTTP_${res.status}`;
    throw err;
  }
}
