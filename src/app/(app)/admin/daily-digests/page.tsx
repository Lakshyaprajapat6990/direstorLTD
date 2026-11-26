import type { Metadata } from "next";
import { CalendarDays, FileSpreadsheet, FileText } from "lucide-react";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth/guard";
import { AdminTabs } from "@/components/admin/AdminTabs";
import { EmptyPanel, HeroChip, PageHero, SectionCard } from "@/components/admin/AdminUi";
import { loadDigestConfig } from "@/lib/digest/dailyDigest";

export const metadata: Metadata = { title: "Daily digests" };
export const dynamic = "force-dynamic";

const n = (v: number) => v.toLocaleString("en-GB");
const size = (bytes: number) => (bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export default async function DailyDigestsPage() {
  await requireRole("SUPER_ADMIN");
  const cfg = loadDigestConfig();
  const digests = await db.dailyDigest.findMany({
    orderBy: { day: "desc" },
    take: 120,
    select: { id: true, day: true, newCompanies: true, dissolved: true, officerCompanies: true, directorRows: true, xlsxBytes: true, pdfBytes: true, updatedAt: true },
  });

  return (
    <div className="space-y-6">
      <AdminTabs active="digests" />
      <PageHero
        icon={CalendarDays}
        eyebrow="Super Admin"
        title="Daily digests"
        description="Every UTC day the scheduler turns the previous day's new companies, dissolutions and director updates into an Excel workbook (every row) and a PDF summary."
        compact
      >
        <HeroChip label="Status" value={cfg.enabled ? `On, after ${String(cfg.hourUtc).padStart(2, "0")}:00 UTC` : "Off (DAILY_DIGEST_ENABLED)"} dot={cfg.enabled ? "green" : "amber"} />
        <HeroChip label="Kept for" value={`${cfg.keepDays} days`} />
      </PageHero>

      {digests.length === 0 ? (
        <EmptyPanel
          icon={FileSpreadsheet}
          title="No digests yet"
          description={
            cfg.enabled
              ? "The first digest is built after the next run of the scheduler, for the previous UTC day."
              : "Set DAILY_DIGEST_ENABLED=1 for the scheduler (or build one by hand with npm run jobs:daily-digest)."
          }
        />
      ) : (
        <SectionCard icon={FileSpreadsheet} title="Stored digests" description="Newest first. Downloads are logged.">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2.5">Day (UTC)</th>
                  <th className="px-4 py-2.5 text-right">New</th>
                  <th className="px-4 py-2.5 text-right">Dissolved</th>
                  <th className="px-4 py-2.5 text-right">Directors updated</th>
                  <th className="px-4 py-2.5">Built (UTC)</th>
                  <th className="px-4 py-2.5">Download</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {digests.map((d) => (
                  <tr key={d.id} className="hover:bg-slate-50/60">
                    <td className="whitespace-nowrap px-4 py-2.5 font-medium text-slate-900">{d.day.toISOString().slice(0, 10)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{n(d.newCompanies)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{n(d.dissolved)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {n(d.officerCompanies)} <span className="text-xs text-slate-400">({n(d.directorRows)} rows)</span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-xs text-slate-500">{d.updatedAt.toISOString().replace("T", " ").slice(0, 16)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <a className="mr-3 inline-flex items-center gap-1 font-medium text-indigo-700 hover:underline" href={`/api/admin/daily-digests/${d.id}/xlsx`}>
                        <FileSpreadsheet className="h-4 w-4" aria-hidden /> Excel <span className="text-xs font-normal text-slate-400">{size(d.xlsxBytes)}</span>
                      </a>
                      <a className="inline-flex items-center gap-1 font-medium text-indigo-700 hover:underline" href={`/api/admin/daily-digests/${d.id}/pdf`}>
                        <FileText className="h-4 w-4" aria-hidden /> PDF <span className="text-xs font-normal text-slate-400">{size(d.pdfBytes)}</span>
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}
    </div>
  );
}
