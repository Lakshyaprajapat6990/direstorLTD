"use client";

import { CONSENT_COOKIE, CONSENT_EVENT, clearConsentCookieString, consentCookieString, parseConsent, type Consent } from "@/lib/consent";

// Browser-side access to the consent cookie, shaped for useSyncExternalStore: the server snapshot is null ("not known yet"), the
// client snapshot is the raw cookie value ("" when there is none). Components parse it with parseConsent.

export function subscribeConsent(onChange: () => void): () => void {
  window.addEventListener(CONSENT_EVENT, onChange);
  return () => window.removeEventListener(CONSENT_EVENT, onChange);
}

export function getConsentSnapshot(): string {
  const prefix = `${CONSENT_COOKIE}=`;
  for (const part of document.cookie.split(";")) {
    const p = part.trim();
    if (p.startsWith(prefix)) return p.slice(prefix.length);
  }
  return "";
}

export const getServerConsentSnapshot = (): string | null => null;

export function readConsent(raw: string | null): Consent | null {
  return raw === null ? null : parseConsent(raw);
}

const isSecurePage = () => window.location.protocol === "https:";

// Saves the choice and CONFIRMS it was stored by reading it back. Returns false when the browser refused the cookie (cookies blocked),
// in which case nothing is announced and the caller keeps the banner / settings open and says so, instead of pretending it was saved.
export function writeConsent(media: boolean): boolean {
  document.cookie = consentCookieString(media, isSecurePage());
  const saved = parseConsent(getConsentSnapshot());
  if (!saved || saved.media !== media) return false;
  window.dispatchEvent(new Event(CONSENT_EVENT));
  return true;
}

// Forgets the saved choice (the consent cookie only).
export function clearConsent(): void {
  document.cookie = clearConsentCookieString(isSecurePage());
  window.dispatchEvent(new Event(CONSENT_EVENT));
}
