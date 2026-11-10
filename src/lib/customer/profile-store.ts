import { db } from "@/lib/db";
import { CONSENT_CHANNELS, CONSENT_VERSION, CONSENT_WORDING, type ConsentChannel } from "@/lib/customer/consent-text";
import { emptyProfile, PROFILE_FIELDS, type ProfileField, type ProfileValues } from "@/lib/customer/profile";

// The form and API call the third address line "address3". Its database column was created as "address4" (the migration is already
// applied, and renaming a column holding customer data is neither needed nor safe), so the two are mapped here and only here.
const COLUMN: Record<ProfileField, string> = { ...Object.fromEntries(PROFILE_FIELDS.map((f) => [f, f])), address3: "address4" } as Record<ProfileField, string>;
type Row = Record<string, unknown>;
const read = (row: Row | null | undefined, f: ProfileField) => (row?.[COLUMN[f]] as string | null | undefined) ?? null;

// Server-side reads and writes of a customer's own details and marketing choices. Every function takes the userId of the signed-in
// session (never a value from the request), so one customer can only ever reach their own rows.

export async function loadProfile(userId: string): Promise<{ values: ProfileValues; phoneVerified: boolean }> {
  const row = await db.customerProfile.findUnique({ where: { userId } });
  const values = emptyProfile();
  if (row) for (const f of PROFILE_FIELDS) values[f] = read(row, f) ?? "";
  return { values, phoneVerified: !!row?.phoneVerifiedAt };
}

// Saves exactly the submitted details. Consent is never read or written here, so editing a profile cannot change a marketing
// choice - with one deliberate exception: removing the phone number withdraws SMS marketing consent (there is no longer a number
// to send to), and that withdrawal is recorded as such. Changing the number clears its (future) verification.
export async function saveProfile(userId: string, v: ProfileValues): Promise<{ changed: ProfileField[]; smsWithdrawn: boolean }> {
  const data = Object.fromEntries(PROFILE_FIELDS.map((f) => [COLUMN[f], v[f] || null])) as Record<string, string | null>;
  return db.$transaction(async (tx) => {
    const before = await tx.customerProfile.findUnique({ where: { userId } });
    const changed = PROFILE_FIELDS.filter((f) => (read(before, f) ?? "") !== v[f]);
    const phoneChanged = (before?.phone ?? null) !== (data.phone ?? null);
    await tx.customerProfile.upsert({
      where: { userId },
      create: { userId, ...data },
      update: { ...data, ...(phoneChanged ? { phoneVerifiedAt: null } : {}) },
    });
    let smsWithdrawn = false;
    if (!data.phone) {
      const latest = await tx.consentRecord.findFirst({ where: { userId, channel: "sms" }, orderBy: { createdAt: "desc" } });
      if (latest?.granted) {
        await tx.consentRecord.create({ data: { userId, channel: "sms", granted: false, version: CONSENT_VERSION, wording: CONSENT_WORDING.sms.statement, source: "phone_removed" } });
        smsWithdrawn = true;
      }
    }
    return { changed, smsWithdrawn };
  });
}

export type ConsentState = Record<ConsentChannel, { granted: boolean; at: string | null; version: string | null }>;
export type ConsentHistoryItem = { channel: ConsentChannel; granted: boolean; version: string; source: string; at: string };

export async function loadConsent(userId: string): Promise<{ state: ConsentState; history: ConsentHistoryItem[] }> {
  const rows = await db.consentRecord.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  const state = Object.fromEntries(CONSENT_CHANNELS.map((c) => [c, { granted: false, at: null, version: null }])) as ConsentState;
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.channel)) continue;
    seen.add(r.channel);
    if (r.channel in state) state[r.channel as ConsentChannel] = { granted: r.granted, at: r.createdAt.toISOString(), version: r.version };
  }
  return {
    state,
    history: rows.slice(0, 20).map((r) => ({ channel: r.channel as ConsentChannel, granted: r.granted, version: r.version, source: r.source, at: r.createdAt.toISOString() })),
  };
}

// Records a change of one channel's choice. Asking for the state a channel is already in writes nothing (so the history shows
// real changes only). Returns what happened so the caller can answer accurately.
export async function setConsent(userId: string, channel: ConsentChannel, granted: boolean): Promise<{ ok: true; changed: boolean } | { ok: false; reason: "phone_required" }> {
  return db.$transaction(async (tx) => {
    const latest = await tx.consentRecord.findFirst({ where: { userId, channel }, orderBy: { createdAt: "desc" } });
    if ((latest?.granted ?? false) === granted) return { ok: true as const, changed: false };
    if (granted && channel === "sms") {
      const p = await tx.customerProfile.findUnique({ where: { userId }, select: { phone: true } });
      if (!p?.phone) return { ok: false as const, reason: "phone_required" as const };
    }
    await tx.consentRecord.create({ data: { userId, channel, granted, version: CONSENT_VERSION, wording: CONSENT_WORDING[channel].statement, source: "settings" } });
    return { ok: true as const, changed: true };
  });
}
