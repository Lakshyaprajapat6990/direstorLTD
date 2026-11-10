import type { Metadata } from "next";
import Link from "next/link";
import { Megaphone, Search, UsersRound } from "lucide-react";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth/guard";
import { AdminTabs } from "@/components/admin/AdminTabs";
import { EmptyPanel, HeroChip, PageHero, StatusPill } from "@/components/admin/AdminUi";
import { customerDisplayName, formatWhen } from "@/lib/customer/admin-format";

export const metadata: Metadata = { title: "Customers" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

// Super Admin only (checked here on the server, which is also what protects the direct URL). Read-only: customers' details and
// marketing choices are shown exactly as stored; nothing on this page changes them or sends anything.
export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  await requireRole("SUPER_ADMIN");
  const sp = await searchParams;
  const q = (sp.q ?? "").trim().slice(0, 80);
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);

  const where: Prisma.UserWhereInput = {
    role: "CUSTOMER",
    ...(q
      ? {
          OR: [
            { email: { contains: q, mode: "insensitive" } },
            { name: { contains: q, mode: "insensitive" } },
            { customerProfile: { is: { OR: [{ firstName: { contains: q, mode: "insensitive" } }, { surname: { contains: q, mode: "insensitive" } }, { businessName: { contains: q, mode: "insensitive" } }, { phone: { contains: q.replace(/[\s()-]/g, "") } }] } } },
          ],
        }
      : {}),
  };
  const [total, allCustomers, emailAllowed, smsAllowed, rows] = await Promise.all([
    db.user.count({ where }),
    db.user.count({ where: { role: "CUSTOMER" } }),
    // "Allowed" = the newest record for the channel is a grant, so count users whose newest email/sms row is a grant.
    db.$queryRaw<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM (SELECT DISTINCT ON ("userId") "granted" FROM "ConsentRecord" WHERE "channel" = 'email' ORDER BY "userId", "createdAt" DESC, "id" DESC) t WHERE "granted"`,
    db.$queryRaw<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM (SELECT DISTINCT ON ("userId") "granted" FROM "ConsentRecord" WHERE "channel" = 'sms' ORDER BY "userId", "createdAt" DESC, "id" DESC) t WHERE "granted"`,
    db.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        email: true,
        name: true,
        active: true,
        createdAt: true,
        customerProfile: { select: { firstName: true, surname: true, businessName: true, phone: true } },
        consentRecords: { orderBy: { createdAt: "desc" }, distinct: ["channel"], select: { channel: true, granted: true, createdAt: true } },
      },
    }),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const href = (p: number) => `/admin/customers?${new URLSearchParams({ ...(q ? { q } : {}), ...(p > 1 ? { page: String(p) } : {}) }).toString()}`;

  const chan = (r: (typeof rows)[number], channel: "email" | "sms") => {
    const c = r.consentRecords.find((x) => x.channel === channel);
    if (!c) return <StatusPill tone="slate">Never allowed</StatusPill>;
    return (
      <span className="inline-flex flex-col gap-0.5">
        <StatusPill tone={c.granted ? "green" : "amber"}>{c.granted ? "Allowed" : "Withdrawn"}</StatusPill>
        <span className="text-[11px] text-slate-500">{formatWhen(c.createdAt)}</span>
      </span>
    );
  };

  return (
    <div className="space-y-6">
      <AdminTabs active="customers" />
      <PageHero icon={UsersRound} eyebrow="Super Admin" title="Customers" description="Free customer accounts, their contact details and the marketing permissions they have given. Read-only." compact>
        <HeroChip label="Customers" value={allCustomers.toLocaleString()} />
        <HeroChip label="Allow marketing emails" value={(emailAllowed[0]?.n ?? 0).toLocaleString()} dot="green" />
        <HeroChip label="Allow marketing texts" value={(smsAllowed[0]?.n ?? 0).toLocaleString()} dot="green" />
      </PageHero>

      <form action="/admin/customers" method="get" role="search" className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="customer-search" className="sr-only">
          Search customers
        </label>
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <input id="customer-search" name="q" defaultValue={q} placeholder="Search by name, email, business or phone" className="h-10 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-sm focus-ring" />
        </div>
        <button type="submit" className="h-10 rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-700 focus-ring">
          Search
        </button>
      </form>

      {rows.length === 0 ? (
        <EmptyPanel icon={UsersRound} title={q ? "No customers match that search" : "No customer accounts yet"} description={q ? "Try a different name, email or phone number." : "Customers appear here after they register for a free account."} />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full min-w-[860px] text-left text-sm">
            <caption className="sr-only">Customers and their marketing permissions</caption>
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-3">Customer</th>
                <th scope="col" className="px-4 py-3">Email</th>
                <th scope="col" className="px-4 py-3">Phone</th>
                <th scope="col" className="px-4 py-3">Marketing emails</th>
                <th scope="col" className="px-4 py-3">Marketing texts</th>
                <th scope="col" className="px-4 py-3">Registered</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 align-top">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50/60">
                  <td className="px-4 py-3">
                    <Link href={`/admin/customers/${r.id}`} className="font-semibold text-indigo-700 hover:underline focus-ring">
                      {customerDisplayName(r.name, r.customerProfile)}
                    </Link>
                    {!r.active && <span className="ml-2 text-xs font-medium text-red-600">Deactivated</span>}
                    {r.customerProfile?.businessName && <div className="text-xs text-slate-500">{r.customerProfile.businessName}</div>}
                  </td>
                  <td className="px-4 py-3 break-all text-slate-700">{r.email}</td>
                  <td className="px-4 py-3 text-slate-700">{r.customerProfile?.phone ?? <span className="text-slate-400">Not provided</span>}</td>
                  <td className="px-4 py-3">{chan(r, "email")}</td>
                  <td className="px-4 py-3">{chan(r, "sms")}</td>
                  <td className="px-4 py-3 text-slate-600">{formatWhen(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <nav aria-label="Pages" className="flex items-center justify-between text-sm text-slate-600">
          <span>
            Page {page} of {pages} ({total.toLocaleString()} customers)
          </span>
          <span className="flex gap-2">
            {page > 1 && (
              <Link href={href(page - 1)} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 hover:bg-slate-50 focus-ring">
                Previous
              </Link>
            )}
            {page < pages && (
              <Link href={href(page + 1)} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 hover:bg-slate-50 focus-ring">
                Next
              </Link>
            )}
          </span>
        </nav>
      )}

      <p className="flex items-start gap-2 text-xs leading-relaxed text-slate-500">
        <Megaphone className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        DIRECTOR.LTD does not currently send marketing emails or text messages, and has no SMS provider or calling system connected. This screen shows who has given or withdrawn permission, so that nothing is ever sent to someone who has not allowed it.
      </p>
    </div>
  );
}
