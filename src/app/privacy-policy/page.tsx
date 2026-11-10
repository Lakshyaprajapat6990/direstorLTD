import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/legal/LegalPage";
import { MONITORING_TEXT } from "@/components/staff/MonitoringNotice";
import { RESET_TOKEN_TTL_MS } from "@/lib/auth/password-reset";
import { SESSION_MAX_AGE_SECONDS } from "@/lib/staff/sessions";
import { CONSENT_VERSION } from "@/lib/customer/consent-text";

export const metadata: Metadata = { title: "Privacy policy" };

// Written from what the application's database schema and code establish. Facts the project does not contain (the legal entity, its
// address and contact details, lawful bases, retention periods for account and activity data, the email provider) are NOT stated: they
// are listed under "Not yet provided" so nobody mistakes silence for a commitment.
export default function PrivacyPolicyPage() {
  return (
    <LegalPage title="Privacy policy" intro="This page explains what personal information the DIRECTOR.LTD software holds about the people who use it, and why.">
      <section>
        <h2>What the site is</h2>
        <p>
          DIRECTOR.LTD is a platform for searching and reporting on UK company information published by Companies House. The company information itself is public register data about companies and their officers; this policy is about information about the <strong>people who use the platform</strong>.
        </p>
      </section>

      <section>
        <h2>Information we hold about users</h2>
        <ul className="prose-list">
          <li><strong>Account details:</strong> your name and email address, your role and permissions, whether the account is active, when it was created and when you last signed in. Your password is never stored; only a one-way hash of it is kept.</li>
          <li><strong>Sign-in sessions:</strong> the time each session started, was last active and ended, and the browser description (user-agent text) it came from. A session cookie lasts at most {Math.round(SESSION_MAX_AGE_SECONDS / 86400)} days.</li>
          <li><strong>Activity records:</strong> {MONITORING_TEXT}</li>
          <li><strong>Free accounts:</strong> which companies a free account has opened, so the free allowance can be applied.</li>
          <li><strong>Optional details (free accounts):</strong> if you choose to add them in Settings, your title, first, middle and last name, business name, address, country, postcode and phone number. None is required. You can change or clear them at any time, and only you (not other customers) can see them in the application.</li>
          <li><strong>Marketing choices:</strong> whether you have allowed marketing emails and/or marketing text messages, and a dated record of each time you changed a choice (what you chose, the wording and version you saw, and when). Both are off unless you turn them on.</li>
          <li><strong>Work you create:</strong> reports, saved companies and flags, notes, follow-ups and contacts you enter, timesheets where used, and a profile picture if you upload one.</li>
          <li><strong>Connected calendar:</strong> if you connect Google Calendar, the account email shown by Google and access tokens, which are stored encrypted.</li>
          <li><strong>Password recovery:</strong> when you ask for a reset link, a one-way hash of the single-use link secret and its expiry time ({Math.round(RESET_TOKEN_TTL_MS / 60000)} minutes) are stored. The link is sent to your registered email address.</li>
          <li><strong>Security records:</strong> short-lived records of sign-in, registration and recovery attempts (including the email address entered and, where the server can see it, the network address) are used to slow down guessing and abuse and are cleared automatically soon after.</li>
        </ul>
      </section>

      <section>
        <h2>What we use it for</h2>
        <p>To provide and secure your account, show you your own work, let supervisors see work that was done, apply the free-account allowance, and send the password-reset email you request. We do not use analytics or advertising technologies on this site; see the <Link href="/cookie-policy">Cookie policy</Link> for the cookies and similar storage it does use.</p>
      </section>

      <section>
        <h2>Marketing</h2>
        <p>
          Marketing emails and marketing text messages are <strong>optional and separate</strong> from running your account. You are never asked to allow them in order to register or to use the account, no box is ticked for you, email and text messages are chosen separately, and you can withdraw either at any time in Settings. Withdrawing does not affect sign-in or anything else on your account. Removing your phone number switches text-message marketing off. The software records your choices; it does not currently send marketing messages itself.
        </p>
        <p>
          The wording of these marketing choices is a <strong>draft (version {CONSENT_VERSION}) that has not yet been reviewed or approved by a legal adviser</strong>; each choice you make is recorded together with the exact wording and version you saw. Allowing marketing texts never counts as verifying your number for anything, and has no effect on how you sign in.
        </p>
      </section>

      <section>
        <h2>Who it is shared with</h2>
        <ul className="prose-list">
          <li>The <strong>email provider</strong> configured by the site operator handles password-reset emails (it receives your email address and the message).</li>
          <li><strong>Google</strong>, only if you choose to connect Google Calendar.</li>
          <li><strong>YouTube or Vimeo</strong>, only if you allow embedded videos on a page that has one.</li>
        </ul>
      </section>

      <section>
        <h2>Your rights</h2>
        <p>
          UK data protection law gives people rights over their personal information, including to see it, correct it, and in some cases have it deleted or restricted, and to complain to the Information Commissioner&rsquo;s Office (ico.org.uk). To use these rights you will need to contact the organisation that runs the site; its details are listed below as not yet provided.
        </p>
      </section>

      <section>
        <h2>Not yet provided</h2>
        <p>The following are not established by the software and have deliberately not been written in. The site owner needs to supply them and have the whole policy reviewed:</p>
        <ul className="prose-list">
          <li>The legal name, address and contact details of the organisation responsible for this site, and any data protection contact.</li>
          <li>The legal basis for each use of information (including how marketing permission wording should be finalised for UK GDPR and PECR).</li>
          <li>How long account, activity and work records are kept, and how deletion requests are handled.</li>
          <li>Which email provider sends password-reset emails, and where information is stored.</li>
        </ul>
      </section>
    </LegalPage>
  );
}
