import { db } from "@/lib/db";
import { CONSENT_WORDING, type ConsentChannel } from "@/lib/customer/consent-text";

// The ONE server-side question to ask before any marketing message is sent: "does this customer currently allow marketing on this
// channel, and is there an address to send it to?" Nothing in the application sends marketing yet (see the Super Admin Customers
// page); this exists so that whatever sender is added later cannot skip the check. Rules, strictest reading:
//   - the account must exist, be active and be a CUSTOMER (staff accounts are never marketed to);
//   - the customer's NEWEST consent record for the channel must be a grant. No record, or the newest being a withdrawal, means no;
//   - the destination must exist (the account email, or a saved phone number for SMS);
//   - anything unclear is a no.
// Transactional account email (password reset) is a different thing and never goes through here.

export type MarketingDecision =
  | { eligible: true; channel: ConsentChannel; to: string; grantedAt: Date; version: string }
  | { eligible: false; channel: ConsentChannel; reason: "no_account" | "inactive" | "not_customer" | "never_consented" | "withdrawn" | "no_destination" };

export interface EligibilityInput {
  channel: ConsentChannel;
  user: { role: string; active: boolean; email: string } | null;
  phone: string | null;
  newest: { granted: boolean; createdAt: Date; version: string } | null;
}

// Pure decision, so it can be tested without a database.
export function decideMarketing(i: EligibilityInput): MarketingDecision {
  const { channel } = i;
  if (!i.user) return { eligible: false, channel, reason: "no_account" };
  if (i.user.role !== "CUSTOMER") return { eligible: false, channel, reason: "not_customer" };
  if (!i.user.active) return { eligible: false, channel, reason: "inactive" };
  if (!i.newest) return { eligible: false, channel, reason: "never_consented" };
  if (i.newest.granted !== true) return { eligible: false, channel, reason: "withdrawn" };
  const to = channel === "email" ? i.user.email.trim() : (i.phone ?? "").trim();
  if (!to) return { eligible: false, channel, reason: "no_destination" };
  return { eligible: true, channel, to, grantedAt: i.newest.createdAt, version: i.newest.version };
}

export async function marketingEligibility(userId: string, channel: ConsentChannel): Promise<MarketingDecision> {
  const [user, profile, newest] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { role: true, active: true, email: true } }),
    db.customerProfile.findUnique({ where: { userId }, select: { phone: true } }),
    db.consentRecord.findFirst({ where: { userId, channel }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { granted: true, createdAt: true, version: true } }),
  ]);
  return decideMarketing({ channel, user, phone: profile?.phone ?? null, newest });
}

export const MARKETING_REASON_TEXT: Record<Extract<MarketingDecision, { eligible: false }>["reason"], string> = {
  no_account: "No such account.",
  not_customer: "Not a customer account.",
  inactive: "The account is deactivated.",
  never_consented: "The customer has never allowed this channel.",
  withdrawn: "The customer has withdrawn permission.",
  no_destination: "There is no address or number to send to.",
};

export const channelLabel = (c: ConsentChannel) => CONSENT_WORDING[c].label;
