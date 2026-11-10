import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, History, Mail, MessageSquare, Phone, UserRound } from "lucide-react";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth/guard";
import { AdminTabs } from "@/components/admin/AdminTabs";
import { PageHero, Panel, StatRow, StatusPill } from "@/components/admin/AdminUi";
import { COUNTRY_CODES, countryName, type ProfileField } from "@/lib/customer/profile";
import { CONSENT_CHANNELS, CONSENT_WORDING, type ConsentChannel } from "@/lib/customer/consent-text";
import { MARKETING_REASON_TEXT, marketingEligibility } from "@/lib/customer/marketing-eligibility";
import { customerDisplayName, formatWhen } from "@/lib/customer/admin-format";
import { appTimezone } from "@/lib/staff/periods";

export const metadata: Metadata = { title: "Customer" };
export const dynamic = "force-dynamic";

const LABEL: Record<ProfileField, string> = { title: "Title", firstName: "First name", middleName: "Middle name", surname: "Last name", businessName: "Business name", phone: "Phone number", address1: "Address 1", address2: "Address 2", address3: "Address 3", town: "Town", state: "State / county", country: "Country", postcode: "Postcode" };
const ORDER: ProfileField[] = ["title", "firstName", "middleName", "surname", "businessName", "phone", "address1", "address2", "address3", "town", "state", "country", "postcode"];
const SOURCE_TEXT: Record<string, string> = { settings: "Customer's Settings page", phone_removed: "Phone number removed by the customer" };
const CHANNEL_ICON = { email: Mail, sms: MessageSquare } as const;

// Super Admin only, read-only. Everything is read from the database for the id in the address; a non-customer id is "not found".
export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole("SUPER_ADMIN");
  const { id } = await params;
  if (!/^[a-z0-9]{10,40}$/i.test(id)) notFound();
  const user = await db.user.findFirst({
    where: { id, role: "CUSTOMER" },
    select: { id: true, email: true, name: true, active: true, createdAt: true, lastLoginAt: true, customerProfile: true },
  });
  if (!user) notFound();

  const [history, eligibility] = await Promise.all([
    db.consentRecord.findMany({ where: { userId: id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 500 }),
    Promise.all(CONSENT_CHANNELS.map((c) => marketingEligibility(id, c))),
  ]);
  const profile = user.customerProfile;
  // Same mapping the customer's own Settings page uses: the third address line is stored in the address4 column.
  const value = (f: ProfileField): string => {
    const raw = ((profile as Record<string, unknown> | null)?.[f === "address3" ? "address4" : f] as string | null | undefined) ?? "";
    return f === "country" && raw && (COUNTRY_CODES as string[]).includes(raw) ? countryName(raw) : raw;
  };
  const name = customerDisplayName(user.name, profile);
  const phone = profile?.phone ?? null;
  const newest = (c: ConsentChannel) => history.find((h) => h.channel === c) ?? null;

  return (
    <div className="space-y-6">
      <AdminTabs active="customers" />
      <Link href="/admin/customers" className="inline-flex items-center gap-1 text-sm font-medium text-indigo-700 hover:underline focus-ring">
        <ChevronLeft className="h-4 w-4" aria-hidden /> All customers
      </Link>
      <PageHero icon={UserRound} eyebrow="Customer" title={name} description={user.email} compact>
        <span className="inline-flex items-center rounded-md bg-white/10 px-3 py-1.5 text-indigo-100 ring-1 ring-white/10">{user.active ? "Active account" : "Deactivated account"}</span>
      </PageHero>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel icon={UserRound} tone="indigo" title="Account">
          <StatRow label="Account name">{user.name || "—"}</StatRow>
          <StatRow label="Email address">
            <span className="break-all">{user.email}</span>
          </StatRow>
          <StatRow label="Registered">{formatWhen(user.createdAt)}</StatRow>
          <StatRow label="Last sign-in">{formatWhen(user.lastLoginAt)}</StatRow>
          <StatRow label="Status" tone={user.active ? "green" : "red"}>
            {user.active ? "Active" : "Deactivated"}
          </StatRow>
        </Panel>

        <Panel icon={Phone} tone="blue" title="Contact details">
          <dl className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
            {ORDER.map((f) => (
              <div key={f} data-field={f} className="border-b border-slate-200/70 py-1.5 text-sm">
                <dt className="text-xs text-slate-500">{LABEL[f]}</dt>
                <dd className={value(f) ? "break-words font-medium text-slate-900" : "text-slate-400"}>{value(f) || "Not provided"}</dd>
              </div>
            ))}
          </dl>
          {phone && (
            <p className="mt-3 text-sm">
              <a href={`tel:${phone}`} className="inline-flex items-center gap-1.5 font-semibold text-indigo-700 hover:underline focus-ring" data-testid="manual-call">
                <Phone className="h-4 w-4" aria-hidden /> Call {phone}
              </a>
              <span className="mt-1 block text-xs text-slate-500">A plain telephone link: it opens your phone or calling app so you can dial manually. DIRECTOR.LTD does not place, record or log calls.</span>
            </p>
          )}
        </Panel>
      </div>

      <Panel icon={Mail} tone="emerald" title="Marketing permissions" right={<span className="text-xs text-slate-500">Times shown in {appTimezone()}</span>}>
        <div className="grid gap-4 md:grid-cols-2">
          {CONSENT_CHANNELS.map((c, i) => {
            const n = newest(c);
            const e = eligibility[i];
            const Icon = CHANNEL_ICON[c];
            return (
              <div key={c} data-channel={c} className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                    <Icon className="h-4 w-4 text-slate-500" aria-hidden /> {CONSENT_WORDING[c].label}
                  </h3>
                  <StatusPill tone={!n ? "slate" : n.granted ? "green" : "amber"}>{!n ? "Never allowed" : n.granted ? "Allowed" : "Withdrawn"}</StatusPill>
                </div>
                <dl className="mt-3 space-y-1.5 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-slate-500">{n ? (n.granted ? "Allowed on" : "Withdrawn on") : "Last change"}</dt>
                    <dd className="font-medium text-slate-900">{n ? formatWhen(n.createdAt) : "—"}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-slate-500">Wording version</dt>
                    <dd className="font-medium text-slate-900">{n?.version ?? "—"}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-slate-500">Destination</dt>
                    <dd className="break-all text-right font-medium text-slate-900">{c === "email" ? user.email : (phone ?? <span className="font-normal text-slate-400">No phone saved</span>)}</dd>
                  </div>
                </dl>
                <p className={e.eligible ? "mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800" : "mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600"} data-eligible={e.eligible ? "yes" : "no"}>
                  {e.eligible ? "May be contacted for marketing on this channel." : `Must not be sent marketing on this channel. ${MARKETING_REASON_TEXT[e.reason]}`}
                </p>
              </div>
            );
          })}
        </div>
        <p className="mt-4 text-xs leading-relaxed text-slate-500">
          This is the customer&rsquo;s current choice, taken from their newest saved record for each channel. DIRECTOR.LTD has no marketing email or SMS sender connected, so nothing can be sent from here and there is no message history to show. Marketing calls are governed separately (for example TPS screening); this screen does not check that.
        </p>
      </Panel>

      <Panel icon={History} tone="slate" title={`Consent history (${history.length})`}>
        {history.length === 0 ? (
          <p className="text-sm text-slate-500">This customer has never made a marketing choice. No permission has been recorded for either channel.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-left text-sm">
              <caption className="sr-only">Every recorded marketing choice, newest first</caption>
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th scope="col" className="py-2 pr-4">When</th>
                  <th scope="col" className="py-2 pr-4">Channel</th>
                  <th scope="col" className="py-2 pr-4">Choice</th>
                  <th scope="col" className="py-2 pr-4">Wording version</th>
                  <th scope="col" className="py-2">Recorded from</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {history.map((h) => (
                  <tr key={h.id} data-testid="consent-row">
                    <td className="py-2 pr-4 text-slate-700">{formatWhen(h.createdAt)}</td>
                    <td className="py-2 pr-4 text-slate-700">{CONSENT_WORDING[h.channel as ConsentChannel]?.label ?? h.channel}</td>
                    <td className="py-2 pr-4">
                      <StatusPill tone={h.granted ? "green" : "amber"}>{h.granted ? "Allowed" : "Withdrawn"}</StatusPill>
                    </td>
                    <td className="py-2 pr-4 text-slate-700">{h.version}</td>
                    <td className="py-2 text-slate-600">{SOURCE_TEXT[h.source] ?? h.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

