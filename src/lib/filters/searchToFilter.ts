import { makeId, type FilterGroupNode, type FilterRule } from "./types";
import { companyNumberSearchKeys } from "./companyNumberQuery";

// A saved report stores only a filter tree. The Companies page also has a search box and an A-Z letter, which are
// separate from the filter tree, so "Save as report" used to drop them and the saved report matched more companies than
// the page the user was looking at. This turns them into ordinary filter rules with exactly the same meaning as the
// search endpoint's own conditions (see buildCompanyWhere):
//   search box  = name contains (any case) OR company number contains OR postcode contains
//                 (or, for company-number-shaped input, the exact company number)
//   A-Z letter  = the "Company name starts with letter" filter (the same definition the A-Z bar uses)
// Nothing changes when neither is set.
const rule = (field: string, operator: FilterRule["operator"], value: string): FilterRule => ({ id: makeId(), kind: "rule", field, operator, value });

export function withSearchAsFilter(filter: FilterGroupNode, q: string | null | undefined, letter: string | null | undefined): FilterGroupNode {
  const term = q?.trim();
  const l = letter?.trim();
  if (!term && !l) return filter;
  const children: FilterGroupNode["children"] = [];
  if (filter.children.length > 0) children.push(filter);
  if (l && /^[A-Za-z]$/.test(l)) children.push(rule("nameLetter", "equals", l.toUpperCase()));
  if (term) {
    // Company-number-shaped input is an exact number lookup in buildCompanyWhere; a saved report must mean the same.
    const numberKeys = companyNumberSearchKeys(term);
    children.push({
      id: makeId(),
      kind: "group",
      combinator: "OR",
      children: numberKeys
        ? numberKeys.map((k) => rule("companyNumber", "equals", k))
        : [rule("name", "contains", term), rule("companyNumber", "contains", term), rule("registeredPostcode", "contains", term)],
    });
  }
  return { id: makeId(), kind: "group", combinator: "AND", children };
}
