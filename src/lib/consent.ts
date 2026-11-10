// Cookie / third-party consent for the PUBLIC site. What the application actually uses (audited from the source and its content
// security policy, see README "Cookies and consent"):
//   strictly necessary - the sign-in session cookie, the calendar-connection OAuth state cookie, a sessionStorage hand-over of a
//                        report filter between two signed-in pages, and this consent record. Always on, not optional.
//   media              - YouTube / Vimeo players, which only appear on a page where an editor added a video section. Third-party
//                        content that can set its own cookies, so it is NOT loaded until the visitor allows it.
// There are no analytics, advertising or tracking scripts, and the CSP (script/img/connect/font: 'self') would block them. Do not
// add a category here unless the application really uses it.
//
// The choice is stored in ONE first-party cookie, `director_consent`, readable by the page (it carries no secret and no personal data):
//   { v: policy version, media: boolean, t: when it was made }
// A record is only honoured while it is well formed, made under the CURRENT version, not future-dated and not older than the cookie's
// own lifetime; anything else counts as "no choice" and the banner is shown again. Raise CONSENT_VERSION when the categories or their
// meaning change, and everyone is asked again.

export const CONSENT_COOKIE = "director_consent";
export const CONSENT_VERSION = 2;
export const CONSENT_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;
export const CONSENT_EVENT = "director:consent-changed";
export const OPEN_SETTINGS_EVENT = "director:open-cookie-settings";
// Development only: open any public page with ?reset-consent=1 to forget the saved choice and see the banner as a first-time visitor.
export const CONSENT_RESET_PARAM = "reset-consent";

export interface Consent {
  v: number;
  media: boolean;
  t: number;
}

const CLOCK_SKEW_MS = 5 * 60 * 1000;

// The stored choice, or null when there is none, it is malformed, it was made under another version, it is dated in the future, or it
// has expired (so the visitor is asked again).
export function parseConsent(raw: string | null | undefined, now: number = Date.now()): Consent | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(decodeURIComponent(raw)) as unknown;
    if (typeof v !== "object" || v === null) return null;
    const o = v as Record<string, unknown>;
    if (o.v !== CONSENT_VERSION || typeof o.media !== "boolean" || typeof o.t !== "number" || !Number.isFinite(o.t)) return null;
    if (o.t > now + CLOCK_SKEW_MS) return null;
    if (now - o.t > CONSENT_MAX_AGE_SECONDS * 1000) return null;
    return { v: CONSENT_VERSION, media: o.media, t: o.t };
  } catch {
    return null;
  }
}

export function serialiseConsent(media: boolean, now: number = Date.now()): string {
  return encodeURIComponent(JSON.stringify({ v: CONSENT_VERSION, media, t: now }));
}

export function readConsentFromCookieString(cookieString: string, now: number = Date.now()): Consent | null {
  for (const part of cookieString.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === CONSENT_COOKIE) return parseConsent(part.slice(i + 1).trim(), now);
  }
  return null;
}

// The Set-Cookie value written by the browser. SameSite=Lax, one cookie, ~6 months, Secure on https.
export function consentCookieString(media: boolean, secure: boolean, now: number = Date.now()): string {
  return `${CONSENT_COOKIE}=${serialiseConsent(media, now)}; Max-Age=${CONSENT_MAX_AGE_SECONDS}; Path=/; SameSite=Lax${secure ? "; Secure" : ""}`;
}

// Deletes only the consent cookie (never the session or anything else).
export function clearConsentCookieString(secure: boolean): string {
  return `${CONSENT_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax${secure ? "; Secure" : ""}`;
}

// The development-only "show me the banner again" switch. Never active in a production build, so a visitor cannot be tricked into
// (or out of) anything by a crafted link.
export function shouldResetConsent(search: string, nodeEnv: string | undefined): boolean {
  return nodeEnv !== "production" && new URLSearchParams(search).get(CONSENT_RESET_PARAM) === "1";
}
