import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ShieldCheck, Building2, Sparkles } from "lucide-react";
import { RegisterForm } from "./RegisterForm";
import { AuthShell } from "@/components/auth/AuthShell";
import { getSession } from "@/lib/auth/session";
import { BrandDot } from "@/components/brand/BrandDot";

export const metadata: Metadata = { title: "Create a free account" };

const POINTS = [
  { icon: Sparkles, text: "Free to join. No payment details needed" },
  { icon: Building2, text: "Companies House intelligence for professionals" },
  { icon: ShieldCheck, text: "Your account is separate from staff and administrator access" },
];

export default async function RegisterPage() {
  // Already signed in: nothing to register. (getSession is null for an expired or ended session, so this can never loop
  // with the proxy, which does not handle /register.)
  if (await getSession({ touch: false })) redirect("/dashboard");

  return (
    <AuthShell
      headline={
        <>
          Create your free <span className="text-sky-300"><span className="whitespace-nowrap">DIRECTOR<BrandDot />LTD</span> account.</span>
        </>
      }
      mobileHeadline={
        <>
          Create your free <span className="text-sky-300"><span className="whitespace-nowrap">DIRECTOR<BrandDot />LTD</span> account.</span>
        </>
      }
      intro="Register in under a minute, then sign in with the email and password you choose."
      points={POINTS}
    >
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">Create your free account</h1>
      <p className="mt-1 text-sm text-slate-500">Tell us who you are and choose a password.</p>

      <div className="mt-6">
        <RegisterForm />
      </div>

      <p className="mt-6 text-center text-xs text-slate-500">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-indigo-600 hover:text-indigo-700">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
