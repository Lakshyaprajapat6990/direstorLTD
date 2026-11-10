import type { Metadata } from "next";
import Link from "next/link";
import { KeyRound, LockKeyhole, ShieldCheck } from "lucide-react";
import { AuthShell } from "@/components/auth/AuthShell";
import { ResetPasswordForm } from "./ResetPasswordForm";

export const metadata: Metadata = { title: "Choose a new password", robots: { index: false, follow: false } };

const POINTS = [
  { icon: LockKeyhole, text: "Pick a password you do not use anywhere else" },
  { icon: ShieldCheck, text: "Other devices are signed out once it is changed" },
  { icon: KeyRound, text: "Your role and access stay exactly as they were" },
];

// The reset secret travels in the URL fragment (#token=...), which browsers never send to a server, so it cannot appear in
// access logs or Referer headers. The form reads it in the browser and removes it from the address bar.
export default function ResetPasswordPage() {
  return (
    <AuthShell
      headline={
        <>
          Choose a new password <span className="text-sky-300">for your account.</span>
        </>
      }
      mobileHeadline={
        <>
          Choose a new <span className="text-sky-300">password.</span>
        </>
      }
      intro="Set a strong password. Once it is changed, the old one stops working."
      points={POINTS}
    >
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">Choose a new password</h1>
      <p className="mt-1 text-sm text-slate-500">This link works once.</p>
      <div className="mt-6">
        <ResetPasswordForm />
      </div>
      <p className="mt-6 text-center text-xs text-slate-500">
        <Link href="/login" className="font-medium text-indigo-600 hover:text-indigo-700">
          Back to sign in
        </Link>
      </p>
    </AuthShell>
  );
}
