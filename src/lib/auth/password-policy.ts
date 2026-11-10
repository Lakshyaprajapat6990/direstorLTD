// Password rules for every user-created or admin-created account.
// Deliberately simple and explainable: length first (NIST 800-63B), plus a
// blocklist of passwords that are trivially guessable.
const COMMON = [
  "password", "passw0rd", "letmein", "welcome", "administrator", "admin", "qwerty", "qwertyuiop",
  "abc123", "iloveyou", "monkey", "dragon", "football", "baseball", "master", "directorltd",
  "directoradmin", "director", "changeme", "changeit", "trustno1", "sunshine",
];

export const MIN_PASSWORD_LENGTH = 8;

export interface PasswordContext {
  email?: string;
  name?: string;
}

// Accents folded, then lower-case letters and digits only, so "John.Smith", "john_smith", "JohnSmith" and "Zoë" / "Zoe" compare equal.
function foldAccents(v: string): string {
  return [...v.normalize("NFKD")].filter((ch) => ch.charCodeAt(0) < 0x300 || ch.charCodeAt(0) > 0x36f).join("");
}
const squash = (v: string) => foldAccents(v).toLowerCase().replace(/[^a-z0-9]/g, "");

// Personal strings a password must not be built from: the email name (whole, and without a +tag), the whole name, and each
// name part of 4+ letters. Anything shorter matches ordinary text by chance.
function personalTokens(context: PasswordContext): string[] {
  const out = new Set<string>();
  const local = context.email?.split("@")[0] ?? "";
  for (const v of [local, local.split("+")[0]]) out.add(squash(v));
  const name = foldAccents(context.name ?? "");
  out.add(squash(name));
  for (const part of name.split(/[^A-Za-z]+/)) out.add(squash(part));
  return [...out].filter((t) => t.length >= 4);
}

// A password is "based on" personal data when it contains such a string and what is left once it is removed is too short to
// be a real secret of its own (under 12 characters, e.g. "john.smith-2026!"). Containing the string by chance inside a long
// unrelated passphrase ("Correct-Horse-Battery-42!" for horse@example.com) is allowed: the rest still carries the strength.
// Separators and case are ignored, so removing a dot or changing case does not slip past the rule.
const MIN_REMAINDER = 12;
function isBuiltFromPersonalData(password: string, context: PasswordContext): boolean {
  const pw = squash(password);
  return personalTokens(context).some((t) => pw.includes(t) && pw.split(t).join("").length < MIN_REMAINDER);
}

// Returns a human-readable reason the password is unacceptable, or null if OK.
export function validatePassword(password: string, context: PasswordContext = {}): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > 200) return "Password is too long.";

  const normalised = password.toLowerCase().replace(/[^a-z0-9]/g, "");
  const lettersOnly = password.toLowerCase().replace(/[^a-z]/g, "");
  for (const bad of COMMON) {
    if (normalised === bad || lettersOnly === bad) return "That password is too common.";
    // "Password1234!"-style: a common word padded with a few extra characters.
    if (normalised.includes(bad) && normalised.length <= bad.length + 5) return "That password is too easy to guess.";
  }
  if (/^(.)\1+$/.test(password)) return "Password cannot be one repeated character.";
  if (/^(0123456789|1234567890|123456789012|abcdefghijkl|qwertyuiopas)/i.test(password)) {
    return "Password is a simple sequence.";
  }
  if (new Set(password).size < 5) return "Use a wider variety of characters.";

  if (isBuiltFromPersonalData(password, context)) return "Password must not be based on the name or email address.";

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (classes < 2 && password.length < 16) return "Mix letters with numbers or symbols, or use 16+ characters.";
  return null;
}
