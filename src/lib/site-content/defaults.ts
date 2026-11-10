// The public landing page's editable copy, as plain typed data. These values are the page's built-in content and its
// permanent fallback: today the page renders them directly; a later phase may layer validated, stored overrides on top
// and fall back to this object field by field.
//
// What does NOT live here, on purpose (see protected-claims.ts and src/app/page.tsx):
//   - every statistic, its label, the "last data sync" date and the notices around them (database-derived),
//   - the Corporate structure and API sections and every "planned / not available" statement,
//   - the filter-field count and anything that interpolates it,
//   - link destinations for buttons and cards (structure, not copy), icons, colours and animation.
// Text is plain strings or RichValue (a string, or formatted runs: see rich.ts). Nothing here is ever rendered as HTML.

import type { RichValue } from "./rich";
import type { ContentStyles, ImageRef, StatLabelKey } from "./styles";
import type { EditableContent } from "./schema";

export type CustomSection = EditableContent["custom"][number];

export interface HeadingParts {
  // `lead` is followed by a space, then `accent` (rendered in the brand blue). Either part may be the whole heading.
  lead: string;
  accent: string;
}

export interface SiteContent {
  hero: {
    heading: HeadingParts;
    intro: RichValue;
    primaryCtaLabel: string;
    secondaryCtaLabel: string;
  };
  builtFor: { label: string; audiences: string[] };
  ukRegister: { eyebrow: string; heading: HeadingParts; intro: RichValue; labels?: Partial<Record<StatLabelKey, string>> };
  officialSource: { eyebrow: string; heading: string; text: RichValue; ctaLabel: string };
  search: {
    eyebrow: string;
    heading: string;
    // Keyed by the tab ids that the component owns.
    tabs: Record<"company" | "filings" | "directors" | "sic", { label: string; hint: string; fields: string[] }>;
  };
  filters: { eyebrow: string; heading: string; text: RichValue };
  workflow: {
    eyebrow: string;
    heading: HeadingParts;
    text: RichValue;
    tabs: Record<"lists" | "reports" | "crm", { label: string; badge: string; title: string; text: RichValue; bullets: string[] }>;
    // Five steps; the component pairs the fourth with its refresh icon and the active-step map, so the count is fixed.
    steps: [string, string, string, string, string];
    tryLabel: string;
  };
  platform: { eyebrow: string; heading: string; text: RichValue; cards: { title: string; text: RichValue }[] };
  apart: {
    eyebrow: string;
    heading: string;
    items: { title: string; text: RichValue }[];
    talk: { title: string; text: RichValue; ctaLabel: string };
    circles?: Partial<Record<"0" | "1" | "2", ImageRef>>;
  };
  useCases: { eyebrow: string; heading: HeadingParts; text: RichValue; items: { tag: string; title: string; text: RichValue; image?: ImageRef }[] };
  faq: { eyebrow: string; heading: string; items: { q: string; a: RichValue }[] };
  finalCta: { heading: string; text: RichValue; primaryLabel: string; secondaryLabel: string };
  header: { links: { href: string; label: string }[] };
  footer: { tagline: string; sectionsTitle: string; links: { href: string; label: string }[] };
  // Sections added by the editor. Absent from the built-in content; present only when stored content has some.
  custom?: CustomSection[];
  // Appearance settings and explicit section order; absent in the built-in content (see styles.ts).
  styles?: ContentStyles;
  order?: string[];
}

export const DEFAULT_SITE_CONTENT: SiteContent = {
  hero: {
    heading: { lead: "UK Company Data Solutions for", accent: "Research & CRM" },
    intro: "Company data on UK businesses, sourced straight from Companies House. Built for teams that search, verify, report and follow up.",
    primaryCtaLabel: "Sign in to the platform",
    secondaryCtaLabel: "Explore UK data",
  },
  builtFor: {
    label: "Built for",
    audiences: ["Accountants", "Formation agents", "Company secretaries", "Business researchers", "Compliance teams"],
  },
  ukRegister: {
    eyebrow: "The UK register. Straight from Companies House.",
    heading: { lead: "Official UK company data,", accent: "one platform" },
    intro: "Companies loaded from Companies House, searchable by name, company number or postcode. Open any company to see its status, address, industry, filing dates and officers where they have been fetched.",
  },
  officialSource: {
    eyebrow: "Official UK source",
    heading: "Company data you can actually use",
    text: "Every record comes from Companies House, the UK registrar, and carries its source. Company data is synchronised from Companies House in stages, and the date of the latest sync run is shown on this page.",
    ctaLabel: "Sign in to the platform",
  },
  search: {
    eyebrow: "Everything there is to know",
    heading: "Search UK company data",
    tabs: {
      company: { label: "Company search", hint: "Search UK companies by name, company number or postcode", fields: ["Company name", "Company number", "Postcode", "Status", "Company type"] },
      filings: { label: "Filings", hint: "Find companies by filing position", fields: ["DS01 strike-off filed", "Late accounts", "Late confirmation statement", "Accounts next due", "Dormant"] },
      directors: { label: "Directors", hint: "Filter by confirmed director data from Companies House", fields: ["Director count", "Single director", "Officer coverage state"] },
      sic: { label: "SIC code", hint: "Filter by UK SIC code, then combine with location and age", fields: ["SIC code", "Town / city", "County", "Postcode prefix", "Company age"] },
    },
  },
  filters: {
    eyebrow: "Powerful filters",
    heading: "Combine anything with AND / OR",
    text: "Nest groups for logic such as (Dormant AND Active) OR DS01 filed. Your own followed, saved and red-flagged companies are filters too.",
  },
  workflow: {
    eyebrow: "Reports, CRM and data sync",
    heading: { lead: "Ready for", accent: "your workflow" },
    text: "Find companies, build lists, follow up and keep it all current from one place.",
    tabs: {
      lists: {
        label: "Lead lists",
        badge: "Lead lists",
        title: "Build a target list in minutes",
        text: "Combine status, age, location, SIC, director and filing filters with AND / OR logic, review the results, then export the list as CSV.",
        bullets: ["Nested AND / OR groups", "Server-side search over every loaded company", "CSV export that respects your filters", "Preview before you save"],
      },
      reports: {
        label: "Saved reports",
        badge: "Saved reports",
        title: "Reports that keep themselves current",
        text: "Save any search as a report. With daily refresh on, its company count is recalculated by the scheduled daily job, and every report shows when it was last updated.",
        bullets: ["Daily refresh with a visible last-update time", "Edit existing reports in place", "Criteria summary on every report", "Open, edit or export in one click"],
      },
      crm: {
        label: "CRM",
        badge: "CRM",
        title: "Follow up where you found the company",
        text: "Follow, save or red-flag a company from the results table, add notes and contacts, and schedule follow-ups that land on a compact calendar.",
        bullets: ["Watches, Saved, Red flags and Trash", "Notes and manual contacts, kept apart from Companies House directors", "Follow-ups with overdue / upcoming / done", "Recently viewed companies"],
      },
    },
    steps: ["Search UK companies", "Filter with AND / OR", "Save as report", "Daily refresh", "Follow, note, schedule"],
    tryLabel: "Sign in to try it",
  },
  platform: {
    eyebrow: "The platform",
    heading: "Everything in one workspace",
    text: "Sign in to open any of these areas.",
    // Same order as the page's card destinations and icons.
    cards: [
      { title: "UK companies", text: "Search the companies loaded from Companies House" },
      { title: "Report builder", text: "Filters with AND / OR and nested groups" },
      { title: "Saved reports", text: "Saved lists with optional daily refresh" },
      { title: "Watches", text: "Follow the companies you care about" },
      { title: "Saved", text: "Your shortlist of companies" },
      { title: "Red flags", text: "Mark companies that need attention" },
      { title: "Calendar", text: "Follow-ups: overdue, upcoming, done" },
      { title: "Company records", text: "Notes, contacts and filing position" },
    ],
  },
  apart: {
    eyebrow: "What sets us apart",
    heading: "We don't stop at the data. We make it work for your business.",
    // Same order as the page's icons.
    items: [
      { title: "Official source only", text: "Company, status, address, SIC, filing dates and officers all come from Companies House. Nothing is scraped, estimated or invented." },
      { title: "Honest about coverage", text: "Director data is collected in stages. A company whose officers are not fetched yet shows “Not fetched”, never zero directors." },
      { title: "Search that scales", text: "Search, filtering, sorting and paging run on the server over every loaded company, so a result is one page away even at millions of rows." },
      { title: "Reports and CRM in one place", text: "Turn a search into a saved report with optional daily refresh, then follow, note and schedule from the same record." },
    ],
    talk: { title: "Talk to us", text: "Questions about access? Sign in or ask your Super Admin to add you.", ctaLabel: "Sign in" },
  },
  useCases: {
    eyebrow: "Data for everyday decisions",
    heading: { lead: "When accuracy is", accent: "non-negotiable" },
    text: "Registry-sourced data for the people who work with UK companies every day.",
    // Same order as the page's colour treatments.
    items: [
      { tag: "ACCOUNTANTS", title: "Late accounts and confirmation statements", text: "Filter by overdue accounts and confirmation statements, save the list and chase it." },
      { tag: "FORMATION AGENTS", title: "Strike-off and newly dormant companies", text: "Find companies with a recorded DS01 strike-off filing, and dormant companies." },
      { tag: "COMPLIANCE", title: "Know who the directors are", text: "Check status, address, filings and confirmed officers on one structured record." },
    ],
  },
  faq: {
    eyebrow: "FAQ",
    heading: "Questions, answered.",
    // The FAQ entries about update frequency, the API and ownership data are protected claims: see protected-claims.ts.
    items: [
      { q: "Where does the data come from?", a: "From Companies House: its published company data file, newly incorporated companies, strike-off filing events (DS01 and DS02) and officer records. Coverage depends on what has been loaded so far, and officer data is collected in stages. Nothing is scraped or estimated." },
      { q: "What does “not fetched” mean for directors?", a: "Officer data is collected from Companies House in stages. A company whose officers have not been fetched yet is shown as not fetched, never as zero directors, and director filters only evaluate companies with confirmed officer data." },
      { q: "Can I export results?", a: "Yes. Any search, filter or saved report can be exported as CSV. Exports follow your filters and are protected against spreadsheet formula injection." },
    ],
  },
  finalCta: {
    heading: "Ready to work the UK register?",
    text: "Sign in with your team credentials to start searching, filtering and building reports.",
    primaryLabel: "Sign in to DIRECTOR.LTD",
    secondaryLabel: "Explore UK data",
  },
  header: {
    links: [
      { href: "#uk-data", label: "UK data" },
      { href: "#search", label: "Search" },
      { href: "#filters", label: "Filters" },
      { href: "#workflow", label: "Reports & CRM" },
      { href: "#api", label: "API" },
      { href: "#faq", label: "FAQ" },
    ],
  },
  footer: {
    tagline: "UK company intelligence built on Companies House data: search, reports and CRM.",
    sectionsTitle: "On this page",
    links: [
      { href: "#uk-data", label: "UK data" },
      { href: "#search", label: "Search" },
      { href: "#filters", label: "Filters" },
      { href: "#workflow", label: "Reports & CRM" },
      { href: "#api", label: "API" },
      { href: "#faq", label: "FAQ" },
    ],
  },
};
