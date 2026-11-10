// Checks the email settings password recovery depends on, without touching the database.
//   npm run mail:check                       validates the settings and tests the SMTP login (sends NO email)
//   npm run mail:check -- you@example.com    ...and also sends one short test email to that address
// Reads the same environment variables as the app (SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, MAIL_FROM,
// APP_BASE_URL). A local .env file is read if there is one; on a server (Plesk) the variables set for the Node.js app must be
// present in the shell you run this from. Passwords are never printed.
import { appBaseUrl, mailConfig, mailProvider, mailSettingsProblems, resendConfig, sendMail, verifyMailTransport } from "../src/lib/mail";

// Same precedence as Next.js: variables already in the shell win, then .env.local, then .env.
for (const f of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(f);
  } catch {
    /* no such file (normal on a server) or an older Node: the shell environment is used as is */
  }
}

async function main() {
  const to = process.argv[2];
  if (to && (to.startsWith("--") || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to))) throw new Error("Usage: npm run mail:check [-- recipient@example.com]");

  const problems = mailSettingsProblems();
  const cfg = mailConfig();
  const rc = resendConfig();
  console.log("Mail settings");
  if (process.env.RESEND_API_KEY?.trim()) {
    console.log("  PROVIDER       Resend (HTTPS API)");
    console.log(`  RESEND_API_KEY ${rc ? "set (hidden)" : "set, but EMAIL_FROM is missing or invalid"}`);
    console.log(`  EMAIL_FROM     ${rc ? rc.from : "-"}`);
    console.log(`  APP_URL        ${appBaseUrl() ?? "(not set)"}`);
  } else {
  console.log(`  SMTP_HOST      ${cfg ? cfg.host : "(not usable)"}`);
  console.log(`  SMTP_PORT      ${cfg ? cfg.port : "-"}  (${cfg ? (cfg.secure ? "TLS from the first byte" : cfg.requireTLS ? "STARTTLS required" : "NO TLS REQUIRED - test servers only") : "-"})`);
  console.log(`  SMTP_USER      ${cfg?.user ? cfg.user : cfg ? "(none: server needs no login)" : "-"}`);
  console.log(`  SMTP_PASS      ${cfg?.user ? "set (hidden)" : "-"}`);
  console.log(`  MAIL_FROM      ${cfg ? cfg.from : "-"}`);
  console.log(`  APP_BASE_URL   ${appBaseUrl() ?? "(not set)"}`);
  }
  if (problems.length) {
    console.error("\nProblems found:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }

  console.log(mailProvider() === "resend" ? "\nContacting the Resend API..." : "\nConnecting to the SMTP server...");
  const check = await verifyMailTransport();
  if (!check.ok) {
    console.error(`FAILED (${check.code}): ${check.message}`);
    if (check.code === "invalid_api_key") console.error("  Resend does not recognise this API key. Check RESEND_API_KEY in .env.local.");
    if (check.code === "EAUTH") console.error("  The server refused the login. For Gmail use a Google App Password (not the account password) and make sure 2-Step Verification is on.");
    if (check.code === "ECONNECTION" || check.code === "ETIMEDOUT" || check.code === "ESOCKET") console.error("  The server could not be reached or the TLS handshake failed: check SMTP_HOST, SMTP_PORT and SMTP_SECURE, and that this machine may connect out on that port.");
    process.exitCode = 1;
    return;
  }
  console.log(mailProvider() === "resend" ? "OK: Resend accepted the API key. (No email was sent.)" : "OK: connected, TLS negotiated and login accepted. (This proves the settings work; no email was sent.)");

  if (!to) {
    console.log("\nTo send one real test email, run: npm run mail:check -- you@example.com");
    return;
  }
  await sendMail({
    to,
    subject: "DIRECTOR.LTD email test",
    text: "This is a test message from DIRECTOR.LTD. If you can read it, the application can send email.",
    html: "<p>This is a test message from DIRECTOR.LTD. If you can read it, the application can send email.</p>",
  });
  console.log(`\nThe mail provider accepted a test email for ${to}. Check that inbox (and spam): only receiving it proves delivery.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
