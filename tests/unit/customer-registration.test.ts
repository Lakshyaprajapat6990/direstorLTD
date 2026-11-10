import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRegistration, normaliseEmail, normaliseName } from "../../src/lib/auth/registration";
import { ALL_PERMISSION_KEYS, CUSTOMER_PERMISSIONS, can, resolvePermissions, parsePermissions } from "../../src/lib/auth/permissions";

const good = { name: "Jane Smith", email: "Jane.Smith@Example.COM ", password: "Correct-Horse-Battery-42!", confirmPassword: "Correct-Horse-Battery-42!" };

test("a valid registration is normalised (email trimmed + lower-cased, name whitespace collapsed)", () => {
  const r = validateRegistration({ ...good, name: "  Jane   Smith " });
  assert.ok(r.ok);
  assert.deepEqual(r.value, { name: "Jane Smith", email: "jane.smith@example.com", password: good.password });
});

test("missing and non-string fields are rejected per field", () => {
  const r = validateRegistration({});
  assert.ok(!r.ok);
  assert.ok(r.errors.name && r.errors.email && r.errors.password && r.errors.confirmPassword);
  const weird = validateRegistration({ name: { a: 1 }, email: 5, password: ["x"], confirmPassword: null });
  assert.ok(!weird.ok);
  assert.ok(weird.errors.name && weird.errors.email && weird.errors.password);
});

test("malformed emails are rejected", () => {
  for (const email of ["plain", "a@b", "a b@c.com", "@c.com", "a@.com", "a@c.", "a@@c.com", "x".repeat(250) + "@c.com"]) {
    const r = validateRegistration({ ...good, email });
    assert.ok(!r.ok && r.errors.email, `should reject ${email.slice(0, 30)}`);
  }
});

test("weak passwords and a mismatched confirmation are rejected", () => {
  for (const password of ["short1!", "password", "Password1234", "aaaaaaaaaaaa", "12345678901234"]) {
    const r = validateRegistration({ ...good, password, confirmPassword: password });
    assert.ok(!r.ok && r.errors.password, `should reject ${password}`);
  }
  const mismatch = validateRegistration({ ...good, confirmPassword: "Correct-Horse-Battery-43!" });
  assert.ok(!mismatch.ok && mismatch.errors.confirmPassword && !mismatch.errors.password);
  const containsEmailName = validateRegistration({ ...good, password: "jane.smith-Is-Great-99", confirmPassword: "jane.smith-Is-Great-99" });
  assert.ok(!containsEmailName.ok && containsEmailName.errors.password);
});

test("names with control characters, angle brackets or excessive length are rejected", () => {
  const ch = (n: number) => String.fromCharCode(n);
  for (const name of ["<script>alert(1)</script>", `Jane${ch(0)}Smith`, `Jane${ch(7)}Smith`, "x".repeat(101)]) {
    const r = validateRegistration({ ...good, name });
    assert.ok(!r.ok && r.errors.name, `should reject ${JSON.stringify(name.slice(0, 20))}`);
  }
  const sep = validateRegistration({ ...good, name: `Jane${ch(0x2028)}Smith` });
  assert.ok(sep.ok && sep.value.name === "Jane Smith", "line separators fold into a space");
  assert.equal(normaliseName(`Zoe${ch(0x301)}  O'Brien`), `Zoe${ch(0x301)} O'Brien`.normalize("NFC"));
  assert.equal(normaliseEmail("  A@B.Co "), "a@b.co");
});

test("client-supplied role / permission fields are never part of the validated value", () => {
  const r = validateRegistration({ ...good, role: "SUPER_ADMIN", permissions: ["staff.manage"], active: false, managerId: "x" } as Record<string, unknown>);
  assert.ok(r.ok);
  assert.deepEqual(Object.keys(r.value).sort(), ["email", "name", "password"]);
});

test("Phase One: CUSTOMER always gets the fixed platform set, whatever is (or is not) stored, and never an administration key", () => {
  const fixed = [...CUSTOMER_PERMISSIONS];
  for (const stored of [null, undefined, "[]", "not json", JSON.stringify(ALL_PERMISSION_KEYS)]) assert.deepEqual(resolvePermissions("CUSTOMER", stored), fixed, String(stored));
  const customer = { role: "CUSTOMER" as const, permissions: fixed };
  // The features Nick asked for.
  for (const key of ["companies.view", "companies.advancedSearch", "companies.directors", "crm.manage", "crm.notes", "calendar.use", "reports.create", "reports.viewOwn", "reports.edit", "reports.exportCsv", "reports.exportDocs", "reports.share"] as const) {
    assert.equal(can(customer, key), true, key);
  }
  // Never administration, other people's reports, or the staff work queue / timesheets.
  for (const key of ["staff.view", "staff.activity", "staff.manage", "team.assign", "timesheets.approve", "reports.viewOthers", "work.assigned", "timesheets.submit"] as const) {
    assert.equal(can(customer, key), false, key);
  }
  assert.deepEqual(parsePermissions("[]"), []);
});

test("existing roles resolve exactly as before (no regression)", () => {
  assert.deepEqual(resolvePermissions("SUPER_ADMIN", null), ALL_PERMISSION_KEYS);
  assert.ok(resolvePermissions("USER", null).includes("companies.view"));
  assert.ok(!resolvePermissions("USER", null).includes("staff.manage"));
  assert.ok(resolvePermissions("ADMIN", null).includes("staff.manage"));
});
