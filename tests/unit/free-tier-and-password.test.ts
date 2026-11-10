import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { validatePassword } from "../../src/lib/auth/password-policy";
import { validateRegistration } from "../../src/lib/auth/registration";
import { DEFAULT_FREE_COMPANY_VIEW_LIMIT, FREE_SEARCH_MIN_CHARS, freeCompanyViewLimit, freeSearchTerm } from "../../src/lib/customer/free-tier";
import { NAV_ITEMS, visibleNavItems } from "../../src/lib/nav";
import { resolvePermissions } from "../../src/lib/auth/permissions";
import type { UserRole } from "../../src/lib/types";

// ---- Password rule: the reported "cannot contain the name / email" failure ------------------------------------------------
// Root cause: the rule rejected ANY password containing the whole email local part (so a long strong passphrase that merely
// contained "horse" failed for horse@...), yet was trivially bypassed by removing a separator (john.smith vs JohnSmith), and the
// name was never checked at all. It now compares ignoring case and separators, for the email name AND the name, and rejects only
// passwords built mostly from that personal data.
const ok = (pw: string, ctx: { email?: string; name?: string }) => validatePassword(pw, ctx) === null;
const bad = (pw: string, ctx: { email?: string; name?: string }) => typeof validatePassword(pw, ctx) === "string";

test("regression: a strong passphrase that merely contains a word from the email or name is accepted", () => {
  assert.ok(ok("Correct-Horse-Battery-42!", { email: "horse@example.com", name: "Horse Lee" }));
  assert.ok(ok("Blue-Admin-Panda-7731!", { email: "admin@example.com" }));
  assert.ok(ok("Sunny-Harbour-Tractor-91", { email: "sunny@example.com", name: "Sunny Day" }));
  assert.ok(bad("Ahmed-Wajid-2026!zq", { email: "ahmedwajid331@gmail.com", name: "Ahmed Wajid" }), "full name + short suffix is still personal data");
});

test("passwords built from the email name or the name are rejected, whatever the case or separators", () => {
  const ctx = { email: "john.smith@example.com", name: "John Smith" };
  for (const pw of ["John.Smith-2026!", "johnsmith2026!!", "JohnSmith-2026!", "JOHN_SMITH_99!", "smith.john.1!", "Smith-2026-zz!", "John#2026-ab!"]) assert.ok(bad(pw, ctx), pw);
  assert.ok(bad("Ahmedwajid331-xx!", { email: "ahmedwajid331@gmail.com" }));
  assert.ok(bad("Wajid-2026-ab!", { email: "x.y@z.com", name: "Ahmed Wajid" }), "a name part is enough");
  assert.ok(bad("ana.lopez-77!x", { email: "ana.lopez+sales@x.com" }), "the +tag is ignored");
  assert.ok(bad("Zoë-Müller-12!", { name: "Zoe Muller" }), "accents are folded");
});

test("unrelated strong passwords are accepted and short name fragments never trigger the rule", () => {
  assert.ok(ok("Xk9!mQ2#vLp7Rt", { email: "john.smith@example.com", name: "John Smith" }));
  assert.ok(ok("Gr33n-Kettle-Oak!", { email: "jo@x.com", name: "Jo Li" }), "names under 4 letters are ignored");
  assert.ok(ok("Tr0ub4dor&3-Keyboard-Vault", { email: "wajid.ahmed@x.com", name: "Wajid Ahmed" }));
});

test("the other password requirements are unchanged", () => {
  const ctx = { email: "a@b.com", name: "A B" };
  assert.ok(bad("short1!", ctx));
  assert.ok(bad("password", ctx));
  assert.ok(bad("Password1234", ctx));
  assert.ok(bad("aaaaaaaaaaaa", ctx));
  assert.ok(bad("12345678901234", ctx));
  assert.ok(bad("x".repeat(201), ctx));
  assert.ok(bad("onlyletterslong", ctx), "one character class under 16 characters");
  assert.ok(ok("Correct-Horse-Battery-42!", ctx));
});

test("the registration form and the server use the same rule (name is part of the check)", () => {
  const base = { name: "Jane Smith", email: "jane.smith@example.com" };
  const mine = validateRegistration({ ...base, password: "JaneSmith-2026!", confirmPassword: "JaneSmith-2026!" });
  assert.ok(!mine.ok && mine.errors.password);
  const fine = validateRegistration({ ...base, password: "Correct-Horse-Battery-42!", confirmPassword: "Correct-Horse-Battery-42!" });
  assert.ok(fine.ok);
});

test("the Create user form checks the password with the shared function before submitting", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../src/app/(app)/users/UsersClient.tsx"), "utf8");
  assert.match(src, /validatePassword\(form\.password, \{ email: form\.email/);
  const api = fs.readFileSync(path.join(__dirname, "../../src/app/api/users/route.ts"), "utf8");
  assert.match(api, /validatePassword\(input\.password, \{ email: input\.email, name: input\.name \}\)/);
});

// ---- Free tier --------------------------------------------------------------------------------------------------------
test("the free quota defaults to 10 and only accepts a sane override", () => {
  const prev = process.env.FREE_CUSTOMER_COMPANY_VIEWS;
  try {
    delete process.env.FREE_CUSTOMER_COMPANY_VIEWS;
    assert.equal(freeCompanyViewLimit(), DEFAULT_FREE_COMPANY_VIEW_LIMIT);
    for (const bad of ["0", "-3", "abc", "2.5", "100000", ""]) {
      process.env.FREE_CUSTOMER_COMPANY_VIEWS = bad;
      assert.equal(freeCompanyViewLimit(), DEFAULT_FREE_COMPANY_VIEW_LIMIT, bad);
    }
    process.env.FREE_CUSTOMER_COMPANY_VIEWS = "20";
    assert.equal(freeCompanyViewLimit(), 20);
  } finally {
    if (prev === undefined) delete process.env.FREE_CUSTOMER_COMPANY_VIEWS;
    else process.env.FREE_CUSTOMER_COMPANY_VIEWS = prev;
  }
});

test("free search terms are normalised and too-short or non-text terms are refused", () => {
  assert.equal(freeSearchTerm("  Acme   Ltd "), "Acme Ltd");
  assert.equal(freeSearchTerm("ab"), null);
  assert.equal(freeSearchTerm("   a  "), null);
  assert.equal(freeSearchTerm(5), null);
  assert.equal(freeSearchTerm({ q: "acme" }), null);
  assert.equal(freeSearchTerm("x".repeat(101)), null);
  assert.equal(freeSearchTerm("a".repeat(FREE_SEARCH_MIN_CHARS)), "aaa");
});

test("Phase One: the customer navigation has every platform tool and nothing administrative", () => {
  const rank: Record<UserRole, number> = { CUSTOMER: -1, USER: 0, ADMIN: 1, SUPER_ADMIN: 2 };
  const labels = (role: UserRole) => visibleNavItems({ role, permissions: resolvePermissions(role, null) }, rank).map((i) => i.label);
  assert.deepEqual(
    labels("CUSTOMER").sort(),
    ["Advanced Search", "Calendar", "Dashboard", "Red flags", "Report Builder", "Saved", "Saved Reports", "Settings", "Trash", "UK Companies", "Watches"].sort()
  );
  for (const role of ["CUSTOMER", "USER", "ADMIN", "SUPER_ADMIN"] as const) assert.ok(!labels(role).includes("Find a company"), role);
  for (const admin of ["Users", "Team", "Super Admin"]) assert.ok(!labels("CUSTOMER").includes(admin), admin);
  assert.equal(NAV_ITEMS.filter((i) => i.onlyRole).length, 0);
});

test("every customer API handler authorises through requireCustomerApi before reading the request", () => {
  const root = path.join(__dirname, "../..");
  const files = ["src/app/api/customer/companies/search/route.ts", "src/app/api/customer/companies/[id]/open/route.ts"];
  for (const f of files) {
    const code = fs.readFileSync(path.join(root, f), "utf8");
    const handler = code.slice(code.indexOf("export async function POST"));
    assert.ok(handler.indexOf("requireCustomerApi(request)") > -1 && handler.indexOf("requireCustomerApi(request)") < handler.indexOf("request.json") + (handler.includes("request.json") ? 0 : 1e9), f);
    assert.ok(!/userId\s*[:=]\s*(body|params|searchParams)/.test(code), `${f} must not take a user id from the request`);
  }
  const apiDir = path.join(root, "src/app/api/customer");
  const found: string[] = [];
  const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /route\.ts$/.test(e.name) && found.push(path.relative(root, path.join(d, e.name)).replace(/\\/g, "/"))));
  walk(apiDir);
  assert.deepEqual(found.sort(), [...files].sort(), "a new customer route must be added to this inventory deliberately");
});
