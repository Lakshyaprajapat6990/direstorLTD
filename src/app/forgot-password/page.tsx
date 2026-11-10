import type { Metadata } from "next";
import Link from "next/link";
import { KeyRound, Mail, ShieldCheck } from "lucide-react";
import { AuthShell } from "@/components/auth/AuthShell";
import { appBaseUrl, isMailConfigured, mailSettingsProblems } from "@/lib/mail";
import { makeLogger } from "@/lib/log";
import { ForgotPasswordForm } from "./ForgotPasswordForm";

export const metadata: Metadata = { title: "Forgot password" };
// Reads mail configuration from the environment, so it must be rendered per request, never baked in at build time.
export const dynamic = "force-dynamic";

const log = makeLogger("recovery");
let warned = false; // once per server process, not on every page view
function warnNotConfiguredOnce() {
  if (warned) return;
  warned = true;
  log.warn("recovery.not_configured", { problems: mailSettingsProblems() });
}

const POINTS = [
  { icon: Mail, text: "We email a one-time link to your registered address" },
  { icon: KeyRound, text: "The link works once and expires in 30 minutes" },
  { icon: ShieldCheck, text: "We never email passwords and never ask for your current one" },
];

export default function ForgotPasswordPage() {
  // Whether this system can send email at all is configuration, not account information, so it is safe to say.
  const available = isMailConfigured() && appBaseUrl() !== null;
  // For whoever runs the server: names the missing or invalid SETTINGS (never their values). The visitor only sees the plain notice.
  if (!available) warnNotConfiguredOnce();
  return (
    <AuthShell
      headline={
        <>
          Forgot your password? <span className="text-sky-300">We will email you a link.</span>
        </>
      }
      mobileHeadline={
        <>
          Forgot your password? <span className="text-sky-300">Reset it by email.</span>
        </>
      }
      intro="Enter the email address you registered with. If an account exists for it, you will receive a link to choose a new password."
      points={POINTS}
    >
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">Reset your password</h1>
      <p className="mt-1 text-sm text-slate-500">Enter your registered email address.</p>
      <div className="mt-6">
        {available ? (
          <ForgotPasswordForm />
        ) : (
          <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            Password recovery by email is not set up on this system yet. Please contact your administrator to reset your password.
          </div>
        )}
      </div>
      <p className="mt-6 text-center text-xs text-slate-500">
        Remembered it?{" "}
        <Link href="/login" className="font-medium text-indigo-600 hover:text-indigo-700">
          Back to sign in
        </Link>
      </p>
    </AuthShell>
  );
}
