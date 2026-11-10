// Statements about what DIRECTOR.LTD does and does not provide today (data freshness, ownership data). They are code,
// not content: they must stay accurate to the product, so they are never part of the editable defaults and no stored
// content may replace them. The page composes them into the FAQ at fixed positions.

import type { RichValue } from "./rich";

export interface FaqItem {
  q: string;
  a: RichValue;
}

export const PROTECTED_FAQ = {
  updated: {
    q: "How often is it updated?",
    a: "Data is synchronised from Companies House in stages rather than all at once: a monthly company data file, newly incorporated companies, and strike-off filing events (DS01 and DS02) while the filing feed is connected. The date of the latest synchronisation run is shown on this page when it is available. A scheduled daily job can also recalculate overdue flags and recount saved reports that have daily refresh switched on; it does not download full company profiles.",
  },
  ownership: {
    q: "Do you hold ownership or corporate hierarchy data?",
    a: "Not currently. Parent and subsidiary relationships and beneficial ownership are not part of the data DIRECTOR.LTD holds today, so none are shown.",
  },
} as const satisfies Record<string, FaqItem>;

// The update-frequency answer sits second; the ownership answer closes the list.
export function composeFaq(editable: readonly FaqItem[]): FaqItem[] {
  const [first, ...rest] = editable;
  return [...(first ? [first] : []), PROTECTED_FAQ.updated, ...rest, PROTECTED_FAQ.ownership];
}

// The same list with where each row came from: the index into the editable questions, or null for a protected row. The
// visual editor uses it to know which rows are clickable (editable) and which are locked.
export function composeFaqRows(editable: readonly FaqItem[]): (FaqItem & { editableIndex: number | null })[] {
  const rows: (FaqItem & { editableIndex: number | null })[] = [];
  editable.forEach((item, i) => {
    rows.push({ ...item, editableIndex: i });
    if (i === 0) rows.push({ ...PROTECTED_FAQ.updated, editableIndex: null });
  });
  if (editable.length === 0) rows.push({ ...PROTECTED_FAQ.updated, editableIndex: null });
  rows.push({ ...PROTECTED_FAQ.ownership, editableIndex: null });
  return rows;
}
