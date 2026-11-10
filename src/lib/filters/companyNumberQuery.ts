// A search-box term that is a COMPLETE Companies House company number is looked up by exact number instead of by the
// combined "name contains OR number contains OR postcode contains" query. That combined query is a three-way
// trigram OR over a 14M-row table; for a number nobody's name or postcode contains, PostgreSQL can end up walking the
// whole name index to find a handful of rows. An exact match is a single unique-index probe.
//
// Recognised shape (no spaces): exactly 8 characters, the register's fixed number width - 8 digits (03658691), two
// prefix letters + 6 digits (SC004688, NI019468, OC301234) or one letter + 7 digits (R0000017). A company number is
// never longer than 8 characters, so for such a term "contains" and "equals" select the same company.
// Anything shorter is a PARTIAL number (people search "000057" or "PF0000" to list a range) and anything else is a
// name or postcode: those keep the existing name / number / postcode "contains" search unchanged.
const SHAPE = /^(?:\d{8}|[A-Z]{2}\d{6}|[A-Z]\d{7})$/;

export function companyNumberSearchKeys(term: string | null | undefined): string[] | null {
  const t = (term ?? "").trim().toUpperCase();
  return SHAPE.test(t) ? [t] : null;
}
