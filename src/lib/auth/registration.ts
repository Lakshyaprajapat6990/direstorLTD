import { validatePassword } from "@/lib/auth/password-policy";

// Public customer self-registration: the one validation shared by the form (instant feedback) and the API (authoritative).
// Pure and free of server imports so the client bundle can use it. Only these four fields are ever read from a request;
// anything else a caller sends (role, permissions, active, managerId ...) is never looked at.

export interface RegistrationInput {
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
}

export type RegistrationField = keyof RegistrationInput;
export type RegistrationErrors = Partial<Record<RegistrationField, string>>;

export const MAX_NAME_LENGTH = 100;
export const MAX_EMAIL_LENGTH = 254;

// Pragmatic address check (one @, a dotted domain, no spaces). Deliverability can only be proven by sending mail.
const EMAIL_RE = /^[^\s@]+@[^\s@.][^\s@]*\.[^\s@.]+$/;

// Control characters, line/paragraph separators and angle brackets (a name is rendered in the admin screens).
function hasForbiddenChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || c === 0x3c || c === 0x3e) return true;
  }
  return false;
}

export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function normaliseName(raw: string): string {
  return raw.normalize("NFC").replace(/\s+/g, " ").trim();
}

// Returns the normalised values on success, or a message per failing field.
export function validateRegistration(
  input: Partial<Record<RegistrationField, unknown>>
): { ok: true; value: { name: string; email: string; password: string } } | { ok: false; errors: RegistrationErrors } {
  const errors: RegistrationErrors = {};
  const str = (v: unknown) => (typeof v === "string" ? v : "");

  const name = normaliseName(str(input.name));
  if (!name) errors.name = "Enter your full name.";
  else if (name.length > MAX_NAME_LENGTH) errors.name = `Use ${MAX_NAME_LENGTH} characters or fewer.`;
  else if (hasForbiddenChar(name)) errors.name = "Your name contains characters that are not allowed.";

  const email = normaliseEmail(str(input.email));
  if (!email) errors.email = "Enter your email address.";
  else if (email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) errors.email = "Enter a valid email address.";

  const password = str(input.password);
  const confirm = str(input.confirmPassword);
  if (!password) errors.password = "Choose a password.";
  else {
    const weakness = validatePassword(password, { email, name });
    if (weakness) errors.password = weakness;
  }
  if (!errors.password && password !== confirm) errors.confirmPassword = "The passwords do not match.";
  else if (!confirm) errors.confirmPassword = "Confirm your password.";

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { name, email, password } };
}
