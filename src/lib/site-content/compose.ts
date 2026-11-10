import type { SiteContent } from "./defaults";
import type { EditableContent } from "./schema";
import { DEFAULT_SITE_CONTENT } from "./defaults";

// Zod-free (type-only imports of the schema), so the editor's browser bundle can build the page from content without it.

// The editable projection of the built-in content (what an editor starts from).
export function toEditable(site: SiteContent = DEFAULT_SITE_CONTENT): EditableContent {
  return {
    hero: { heading: { ...site.hero.heading }, intro: site.hero.intro, primaryCtaLabel: site.hero.primaryCtaLabel, secondaryCtaLabel: site.hero.secondaryCtaLabel },
    builtFor: { label: site.builtFor.label, audiences: [...site.builtFor.audiences] },
    ukRegister: { eyebrow: site.ukRegister.eyebrow, heading: { ...site.ukRegister.heading }, intro: site.ukRegister.intro, ...(site.ukRegister.labels ? { labels: { ...site.ukRegister.labels } } : {}) },
    officialSource: { ...site.officialSource },
    search: {
      eyebrow: site.search.eyebrow,
      heading: site.search.heading,
      tabs: {
        company: { ...site.search.tabs.company, fields: [...site.search.tabs.company.fields] },
        filings: { ...site.search.tabs.filings, fields: [...site.search.tabs.filings.fields] },
        directors: { ...site.search.tabs.directors, fields: [...site.search.tabs.directors.fields] },
        sic: { ...site.search.tabs.sic, fields: [...site.search.tabs.sic.fields] },
      },
    },
    filters: { ...site.filters },
    workflow: {
      eyebrow: site.workflow.eyebrow,
      heading: { ...site.workflow.heading },
      text: site.workflow.text,
      tabs: {
        lists: { ...site.workflow.tabs.lists, bullets: [...site.workflow.tabs.lists.bullets] },
        reports: { ...site.workflow.tabs.reports, bullets: [...site.workflow.tabs.reports.bullets] },
        crm: { ...site.workflow.tabs.crm, bullets: [...site.workflow.tabs.crm.bullets] },
      },
      steps: [...site.workflow.steps],
      tryLabel: site.workflow.tryLabel,
    },
    platform: { eyebrow: site.platform.eyebrow, heading: site.platform.heading, text: site.platform.text, cards: site.platform.cards.map((c) => ({ ...c })) },
    apart: { eyebrow: site.apart.eyebrow, heading: site.apart.heading, items: site.apart.items.map((i) => ({ ...i })), talk: { ...site.apart.talk }, ...(site.apart.circles ? { circles: JSON.parse(JSON.stringify(site.apart.circles)) } : {}) },
    useCases: { eyebrow: site.useCases.eyebrow, heading: { ...site.useCases.heading }, text: site.useCases.text, items: site.useCases.items.map((i) => ({ ...i })) },
    faq: { eyebrow: site.faq.eyebrow, heading: site.faq.heading, items: site.faq.items.map((i) => ({ ...i })) },
    finalCta: { ...site.finalCta },
    header: { links: site.header.links.map((l) => ({ label: l.label })) },
    footer: { tagline: site.footer.tagline, sectionsTitle: site.footer.sectionsTitle, links: site.footer.links.map((l) => ({ label: l.label })) },
    custom: site.custom ? JSON.parse(JSON.stringify(site.custom)) : [],
    ...(site.styles ? { styles: JSON.parse(JSON.stringify(site.styles)) } : {}),
    ...(site.order ? { order: [...site.order] } : {}),
  };
}

// Editable content laid over the built-in content: link destinations (and anything not editable) always come from `base`.
export function applyEditable(base: SiteContent, e: EditableContent): SiteContent {
  const withHrefs = (links: { href: string; label: string }[], edited: { label: string }[]) => links.map((l, i) => ({ href: l.href, label: edited[i]?.label ?? l.label }));
  const out: SiteContent = {
    ...base,
    hero: { ...e.hero },
    builtFor: { ...e.builtFor },
    ukRegister: { ...e.ukRegister },
    officialSource: { ...e.officialSource },
    search: { eyebrow: e.search.eyebrow, heading: e.search.heading, tabs: e.search.tabs },
    filters: { ...e.filters },
    workflow: { ...e.workflow, steps: e.workflow.steps as SiteContent["workflow"]["steps"] },
    platform: { ...e.platform },
    apart: { ...e.apart },
    useCases: { ...e.useCases },
    faq: { ...e.faq },
    finalCta: { ...e.finalCta },
    header: { links: withHrefs(base.header.links, e.header.links) },
    footer: { tagline: e.footer.tagline, sectionsTitle: e.footer.sectionsTitle, links: withHrefs(base.footer.links, e.footer.links) },
  };
  if (e.custom.length > 0) out.custom = e.custom;
  else delete out.custom;
  if (e.styles) out.styles = e.styles;
  else delete out.styles;
  if (e.order) out.order = e.order;
  else delete out.order;
  return out;
}
