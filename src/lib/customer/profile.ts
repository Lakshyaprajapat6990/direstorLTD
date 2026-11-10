// A customer's optional contact details (Settings > Your details). Pure and free of server imports, so the form (instant
// feedback) and the API (authoritative) share one validation.
//
// EVERY field is optional. Nothing in the product needs any of these details, and UK data-protection law asks for no more
// personal data than is needed, so none is mandatory. What IS enforced is shape: if a value is supplied it must be sensible
// (length, characters, a real country code, a plausible postcode for the country, a valid phone number).

export const PROFILE_FIELDS = ["title", "firstName", "middleName", "surname", "businessName", "address1", "address2", "address3", "town", "state", "country", "postcode", "phone"] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];
export type ProfileValues = Record<ProfileField, string>;
export type ProfileErrors = Partial<Record<ProfileField, string>>;

export const TITLES = ["Mr", "Mrs", "Miss", "Ms", "Mx", "Dr", "Prof"] as const;

const MAX: Record<ProfileField, number> = { title: 10, firstName: 60, middleName: 60, surname: 80, businessName: 120, address1: 100, address2: 100, address3: 100, town: 80, state: 80, country: 2, postcode: 12, phone: 24 };

// ISO 3166-1 alpha-2 codes. Display names come from Intl.DisplayNames, so there is no separate name list to keep in step.
export const COUNTRY_CODES = (
  "AF AX AL DZ AS AD AO AI AQ AG AR AM AW AU AT AZ BS BH BD BB BY BE BZ BJ BM BT BO BQ BA BW BV BR IO BN BG BF BI CV KH CM CA KY CF TD CL CN CX CC CO KM CG CD CK CR CI HR CU CW CY CZ DK DJ DM DO EC EG SV GQ ER EE SZ ET FK FO FJ FI FR GF PF TF GA GM GE DE GH GI GR GL GD GP GU GT GG GN GW GY HT HM VA HN HK HU IS IN ID IR IQ IE IM IL IT JM JP JE JO KZ KE KI KP KR KW KG LA LV LB LS LR LY LI LT LU MO MG MW MY MV ML MT MH MQ MR MU YT MX FM MD MC MN ME MS MA MZ MM NA NR NP NL NC NZ NI NE NG NU NF MK MP NO OM PK PW PS PA PG PY PE PH PN PL PT PR QA RE RO RU RW BL SH KN LC MF PM VC WS SM ST SA SN RS SC SL SG SX SK SI SB SO ZA GS SS ES LK SD SR SJ SE CH SY TW TJ TZ TH TL TG TK TO TT TN TR TM TC TV UG UA AE GB UM US UY UZ VU VE VN VG VI WF EH YE ZM ZW"
).split(" ");
const COUNTRY_SET = new Set(COUNTRY_CODES);
export const DEFAULT_COUNTRY = "GB";

export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en-GB"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export const emptyProfile = (): ProfileValues => Object.fromEntries(PROFILE_FIELDS.map((f) => [f, ""])) as ProfileValues;

// Control characters, line/paragraph separators and angle brackets (these values are shown in admin screens).
function hasForbiddenChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || c === 0x3c || c === 0x3e) return true;
  }
  return false;
}
const clean = (raw: unknown) => (typeof raw === "string" ? raw.normalize("NFC").replace(/\s+/g, " ").trim() : "");

// Royal Mail postcode shape (outward + inward code). Shape only: whether the postcode exists is not checked.
const UK_POSTCODE = /^(GIR ?0AA|[A-PR-UWYZ]([0-9]{1,2}|([A-HK-Y][0-9]([0-9ABEHMNPRV-Y])?)|[0-9][A-HJKPS-UW]) ?[0-9][ABD-HJLNP-UW-Z]{2})$/i;
const GENERIC_POSTCODE = /^[A-Z0-9][A-Z0-9 -]{1,10}[A-Z0-9]$/i;

export function normalisePostcode(value: string, country: string): string {
  const v = value.toUpperCase().replace(/\s+/g, " ").trim();
  if (country === "GB") {
    const squashed = v.replace(/ /g, "");
    return squashed.length > 3 ? `${squashed.slice(0, -3)} ${squashed.slice(-3)}` : squashed;
  }
  return v;
}

// Phone numbers are stored as E.164 (+ then 8-15 digits). A UK national number (07..., 01..., 02...) is read as +44 only when the
// country is the UK (or not chosen); an international number must start with + or 00. Independent of the email address.
export function normalisePhone(raw: string, country: string): { ok: true; value: string } | { ok: false; error: string } {
  const text = raw.trim();
  if (!/^[+\d][\d\s().-]*$/.test(text)) return { ok: false, error: "Use digits only, with an optional leading + (spaces, brackets and hyphens are fine)." };
  let digits = text.replace(/[^\d]/g, "");
  if (text.startsWith("+")) {
    // already international
  } else if (digits.startsWith("00")) {
    digits = digits.slice(2);
  } else if (digits.startsWith("0") && (country === "GB" || country === "")) {
    digits = `44${digits.slice(1)}`;
  } else {
    return { ok: false, error: "Start with + and the country code (for example +44 7700 900123), or use a UK number starting 0." };
  }
  if (digits.startsWith("44") && digits.length !== 12 && digits.length !== 11 && digits.length !== 10) {
    // UK numbers: +44 then 9 or 10 digits (some short geographic / special numbers are shorter; reject the clearly wrong)
    return { ok: false, error: "That does not look like a valid UK phone number." };
  }
  if (digits.startsWith("0") || digits.length < 8 || digits.length > 15) return { ok: false, error: "Enter a valid phone number with the country code." };
  return { ok: true, value: `+${digits}` };
}

// Returns the cleaned values (empty string = not provided) or a message per failing field.
export function validateProfile(input: Partial<Record<ProfileField, unknown>>): { ok: true; value: ProfileValues } | { ok: false; errors: ProfileErrors } {
  const errors: ProfileErrors = {};
  const value = emptyProfile();
  for (const f of PROFILE_FIELDS) {
    if (input[f] !== undefined && input[f] !== null && typeof input[f] !== "string") errors[f] = "Enter text.";
    value[f] = clean(input[f]);
  }

  for (const f of PROFILE_FIELDS) {
    if (errors[f] || !value[f]) continue;
    if (value[f].length > MAX[f]) errors[f] = `Use ${MAX[f]} characters or fewer.`;
    else if (hasForbiddenChar(value[f])) errors[f] = "This contains characters that are not allowed.";
  }

  if (!errors.title && value.title && !(TITLES as readonly string[]).includes(value.title)) errors.title = "Choose a title from the list.";

  if (!errors.country && value.country) {
    value.country = value.country.toUpperCase();
    if (!COUNTRY_SET.has(value.country)) errors.country = "Choose a country from the list.";
  }
  const country = errors.country ? "" : value.country;

  if (!errors.postcode && value.postcode) {
    const pc = normalisePostcode(value.postcode, country || DEFAULT_COUNTRY);
    if ((country || DEFAULT_COUNTRY) === "GB") {
      if (country === "GB" && !UK_POSTCODE.test(pc.replace(/ /g, ""))) errors.postcode = "Enter a valid UK postcode, for example SW1A 1AA.";
      else if (!country && !UK_POSTCODE.test(pc.replace(/ /g, "")) && !GENERIC_POSTCODE.test(pc)) errors.postcode = "Enter a valid postcode.";
      else value.postcode = pc;
    } else if (!GENERIC_POSTCODE.test(pc)) errors.postcode = "Enter a valid postcode for the chosen country.";
    else value.postcode = pc;
  }

  if (!errors.phone && value.phone) {
    const r = normalisePhone(value.phone, country);
    if (r.ok) value.phone = r.value;
    else errors.phone = r.error;
  }

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}
