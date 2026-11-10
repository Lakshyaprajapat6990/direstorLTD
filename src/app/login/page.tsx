import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ShieldCheck, Filter, FileSpreadsheet, Users2 } from "lucide-react";
import { LoginForm } from "./LoginForm";
import { AuthShell } from "@/components/auth/AuthShell";
import { MonitoringNotice } from "@/components/staff/MonitoringNotice";

export const metadata: Metadata = { title: "Sign in" };

const FEATURES = [
  { icon: Filter, text: "Build any permutation of Companies House filters" },
  { icon: FileSpreadsheet, text: "Save reports that refresh automatically every day" },
  { icon: Users2, text: "Manage leads with a built-in CRM and follow-ups" },
  { icon: ShieldCheck, text: "Role-based access with full Super Admin oversight" },
];

export default function LoginPage() {
  return (
    <AuthShell
      headline={
        <>
          Companies House intelligence, <span className="text-sky-300">built for professionals.</span>
        </>
      }
      mobileHeadline={
        <>
          Companies House intelligence, <span className="text-sky-300">built for professionals.</span>
        </>
      }
      intro="Search the full UK company register, build custom reports and manage leads, all in one platform."
      points={FEATURES}
    >
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">Welcome back</h1>
      <p className="mt-1 text-sm text-slate-500">Sign in to access your dashboard.</p>

      <div className="mt-6">
        <Suspense>
          <LoginForm />
          <div className="mt-6">
            <MonitoringNotice />
          </div>
        </Suspense>
      </div>

      <p className="mt-6 text-center text-xs text-slate-500">
        New customer?{" "}
        <Link href="/register" className="font-medium text-indigo-600 hover:text-indigo-700">
          Create a free account
        </Link>
      </p>
      <p className="mt-2 text-center text-xs text-slate-500">
        Staff: contact your Super Admin for access.{" "}
        <Link href="/" className="font-medium text-indigo-600 hover:text-indigo-700">
          Back to home
        </Link>
      </p>
    </AuthShell>
  );
}
