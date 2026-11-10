// The marketing permission wording, versioned. This is the text a person sees next to each unticked box, and the exact text stored
// with each choice. CONSERVATIVE DRAFT: Nick's preferred wording was not supplied, and the organisation's legal name, its
// marketing content and its lawful-basis position still need review by whoever is responsible for data protection before launch.
// If a sentence changes, change CONSENT_VERSION too, so older records still show what the person actually agreed to.
//
// Separate from account processing: running the account (sign-in, free allowance, password reset) does not rely on this consent,
// and nothing here is a condition of registering or of using the account.
export const CONSENT_VERSION = "2026-10-draft-1";

export const CONSENT_CHANNELS = ["email", "sms"] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];

export const CONSENT_WORDING: Record<ConsentChannel, { label: string; statement: string }> = {
  email: {
    label: "Marketing emails",
    statement: "I would like DIRECTOR.LTD to send me marketing emails about its products, features and services. I can withdraw this at any time in Settings.",
  },
  sms: {
    label: "Marketing text messages (SMS)",
    statement: "I would like DIRECTOR.LTD to send me marketing text messages about its products, features and services. I can withdraw this at any time in Settings.",
  },
};

export const isConsentChannel = (v: unknown): v is ConsentChannel => typeof v === "string" && (CONSENT_CHANNELS as readonly string[]).includes(v);
