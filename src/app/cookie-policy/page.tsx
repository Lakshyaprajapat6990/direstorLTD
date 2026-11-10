import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/legal/LegalPage";
import { CookieSettingsLink } from "@/components/consent/CookieSettingsLink";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { SESSION_MAX_AGE_SECONDS } from "@/lib/staff/sessions";
import { OAUTH_STATE_COOKIE, OAUTH_STATE_TTL_SECONDS } from "@/lib/calendar/oauth-state";
import { CONSENT_COOKIE, CONSENT_MAX_AGE_SECONDS } from "@/lib/consent";

export const metadata: Metadata = { title: "Cookie policy" };

const days = (s: number) => `${Math.round(s / 86400)} days`;
const minutes = (s: number) => `${Math.round(s / 60)} minutes`;

// Every name and lifetime in the table comes from the constant used by the code that sets it, so this page cannot drift from the
// implementation (a test also fails if a new cookie or storage key is added without being listed here). Anything the code does not
// establish (who runs the site, contact details) is deliberately NOT stated.
interface Row {
  names: string[];
  kind: string;
  provider: string;
  purpose: string;
  lifetime: string;
  category: string;
}
const ROWS: Row[] = [
  { names: [SESSION_COOKIE_NAME], kind: "Cookie", provider: "DIRECTOR.LTD (first party)", purpose: "Keeps you signed in and protects your account. Set only when you sign in. HttpOnly (not readable by page scripts), SameSite=Lax, and Secure on HTTPS.", lifetime: `${days(SESSION_MAX_AGE_SECONDS)}, or until you sign out`, category: "Strictly necessary" },
  { names: [OAUTH_STATE_COOKIE], kind: "Cookie", provider: "DIRECTOR.LTD (first party)", purpose: "Protects the connection of a Google Calendar from forged requests. Set only while a signed-in user starts that connection. HttpOnly, SameSite=Lax, limited to /api/calendar.", lifetime: `${minutes(OAUTH_STATE_TTL_SECONDS)}, deleted when the connection finishes`, category: "Strictly necessary" },
  { names: [CONSENT_COOKIE], kind: "Cookie", provider: "DIRECTOR.LTD (first party)", purpose: "Remembers your cookie choice so you are not asked on every visit. Holds only the policy version, your choice for embedded videos and the time you chose. No personal data.", lifetime: days(CONSENT_MAX_AGE_SECONDS), category: "Strictly necessary (records your choice)" },
  { names: ["pendingReportFilter", "pendingReportQuery", "pendingReportColumns", "pendingReportSort"], kind: "Browser session storage", provider: "DIRECTOR.LTD (first party)", purpose: "Carries the search or filter you were looking at to the Report Builder when a signed-in user clicks to create a report from it. Removed as soon as it is used.", lifetime: "Until used, or until the browser tab is closed", category: "Strictly necessary (for a feature you asked for)" },
  { names: ["cms-colour-memory-v1"], kind: "Browser local storage", provider: "DIRECTOR.LTD (first party)", purpose: "Remembers recently used colours in the website editor. Used only by the Super Admin's editor. Never set for public visitors or customers.", lifetime: "Until cleared from the browser", category: "Staff-only editor preference" },
];

const FIELDS: { key: keyof Row; label: string }[] = [
  { key: "purpose", label: "What it is for" },
  { key: "lifetime", label: "How long" },
  { key: "category", label: "Category" },
];

export default function CookiePolicyPage() {
  return (
    <LegalPage title="Cookie policy" intro="This page explains the cookies and similar technologies DIRECTOR.LTD uses, why, and how to change your choices.">
      <nav aria-label="On this page" className="text-sm">
        <ul className="flex flex-wrap gap-x-6 gap-y-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
          <li><a href="#what-we-use">What we use</a></li>
          <li><a href="#embedded-videos">Embedded videos</a></li>
          <li><a href="#change-your-choice">Change or withdraw your choice</a></li>
        </ul>
      </nav>

      <section>
        <h2>What cookies and similar technologies are</h2>
        <p>
          Cookies are small text files a website stores in your browser. Similar technologies, such as the browser&rsquo;s session storage and local storage, also keep small pieces of information on your device. Some are essential for a site to work; others are optional. Every one the application uses is listed below.
        </p>
      </section>

      <section id="what-we-use" data-wide>
        <h2 className="scroll-mt-6">What we use</h2>
        {/* Wide screens: a table. Phones: one card per item (nothing scrolls sideways). The hidden copy is removed from the page for screen readers too. */}
        <div className="hidden overflow-hidden rounded-xl border border-slate-200 md:block">
          <table className="w-full table-fixed text-left text-[13px]">
            <caption className="sr-only">Cookies and similar storage used by DIRECTOR.LTD</caption>
            <colgroup>
              <col className="w-[21%]" />
              <col className="w-[14%]" />
              <col className="w-[31%]" />
              <col className="w-[16%]" />
              <col className="w-[18%]" />
            </colgroup>
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-3 py-2.5">Name</th>
                <th scope="col" className="px-3 py-2.5">Type and provider</th>
                <th scope="col" className="px-3 py-2.5">What it is for</th>
                <th scope="col" className="px-3 py-2.5">How long</th>
                <th scope="col" className="px-3 py-2.5">Category</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 align-top">
              {ROWS.map((r) => (
                <tr key={r.names[0]}>
                  <th scope="row" className="px-3 py-3 font-mono text-[12px] font-semibold text-slate-900">
                    {r.names.map((n) => (
                      <span key={n} className="block break-all">{n}</span>
                    ))}
                  </th>
                  <td className="px-3 py-3">
                    <span className="block font-medium text-slate-900">{r.kind}</span>
                    <span className="block text-slate-600">{r.provider}</span>
                  </td>
                  <td className="px-3 py-3">{r.purpose}</td>
                  <td className="px-3 py-3">{r.lifetime}</td>
                  <td className="px-3 py-3">{r.category}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="space-y-3 md:hidden" aria-label="Cookies and similar storage used by DIRECTOR.LTD">
          {ROWS.map((r) => (
            <li key={r.names[0]} className="rounded-xl border border-slate-200 p-4">
              <p className="font-mono text-[13px] font-semibold text-slate-900">
                {r.names.map((n) => (
                  <span key={n} className="block break-all">{n}</span>
                ))}
              </p>
              <p className="mt-1 text-[13px] text-slate-600">
                {r.kind}, {r.provider}
              </p>
              <dl className="mt-3 space-y-2 text-[13px]">
                {FIELDS.map((f) => (
                  <div key={f.key}>
                    <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{f.label}</dt>
                    <dd className="mt-0.5">{r[f.key]}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      </section>

      <section id="embedded-videos">
        <h2>Optional: embedded videos</h2>
        <p>
          A page on this site can contain a YouTube or Vimeo video if an editor adds one. These are the only optional technologies the site has. Their players come from <strong>youtube-nocookie.com</strong> (YouTube, a Google service) and <strong>player.vimeo.com</strong> (Vimeo), and those companies may set their own cookies or read information from your device when a player loads, under their own policies.
        </p>
        <ul className="prose-list mt-3">
          <li>Until you allow embedded videos, the player is <strong>not loaded</strong>: your browser makes no request to YouTube or Vimeo, and a placeholder is shown instead.</li>
          <li>If you allow them and later change your mind, the player is removed from the page straight away. Cookies a provider has already stored on its own domain can only be removed through your browser&rsquo;s settings.</li>
          <li>Most pages have no video at all, in which case this setting has no effect.</li>
        </ul>
      </section>

      <section>
        <h2>What we do not use</h2>
        <p>
          We checked the site&rsquo;s code and its content security policy, which only lets pages load scripts, images, fonts and data connections from the site itself. The site does not load analytics, advertising or tracking scripts, tracking pixels or social-media widgets, and the fonts are served from the site itself rather than from a font provider.
        </p>
      </section>

      <section>
        <h2>Things you start yourself</h2>
        <ul className="prose-list">
          <li>If a signed-in user chooses to connect Google Calendar, they are taken to Google&rsquo;s own sign-in page. Google&rsquo;s cookies and policies apply there.</li>
          <li>If a signed-in user chooses to share a report by WhatsApp or LinkedIn, that site opens in a new tab only after they click.</li>
          <li>If you choose &ldquo;Take a photo&rdquo; for a profile picture, your browser asks permission to use the camera. This is a browser permission, not a cookie, and the camera switches off as soon as you finish.</li>
        </ul>
      </section>

      <section id="change-your-choice">
        <h2>Changing or withdrawing your choice</h2>
        <p>
          You can review or change your choice at any time with <CookieSettingsLink className="font-semibold text-indigo-700 underline underline-offset-2 focus-ring" /> here, or from the link at the bottom of the home page. Rejecting optional technologies does not affect signing in or any other part of the site. You can also delete or block cookies in your browser&rsquo;s settings; blocking the strictly necessary cookies will stop sign-in from working.
        </p>
      </section>

      <section>
        <h2>Contact and more information</h2>
        <p>
          Contact details for the organisation that runs this site have not been added to this page yet. How we handle personal information is described in the <Link href="/privacy-policy">Privacy policy</Link>. General guidance on cookies is published by the UK Information Commissioner&rsquo;s Office at ico.org.uk.
        </p>
      </section>
    </LegalPage>
  );
}
