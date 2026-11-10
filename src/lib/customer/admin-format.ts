import { appTimezone } from "@/lib/staff/periods";

// Small display helpers for the Super Admin Customers screens.

export function customerDisplayName(accountName: string, profile: { firstName: string | null; surname: string | null } | null | undefined): string {
  const fromProfile = [profile?.firstName, profile?.surname].filter(Boolean).join(" ").trim();
  return fromProfile || accountName || "(no name)";
}

// "3 Nov 2026, 10:58" in the application's timezone (APP_TIMEZONE, default Europe/London). A customer sees the same moment in their
// own browser's timezone, so the two can differ by the offset.
export function formatWhen(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString("en-GB", { timeZone: appTimezone(), day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
