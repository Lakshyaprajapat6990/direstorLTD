import { test } from "node:test";
import assert from "node:assert/strict";
import { decideMarketing, type EligibilityInput } from "../../src/lib/customer/marketing-eligibility";
import { customerDisplayName } from "../../src/lib/customer/admin-format";

const T = new Date("2026-11-03T10:58:00Z");
const customer = { role: "CUSTOMER", active: true, email: "ada@example.com" };
const base = (over: Partial<EligibilityInput>): EligibilityInput => ({ channel: "email", user: customer, phone: "+447700900123", newest: { granted: true, createdAt: T, version: "v1" }, ...over });

test("marketing is allowed only when the newest record for that channel is a grant and there is somewhere to send it", () => {
  const e = decideMarketing(base({}));
  assert.equal(e.eligible, true);
  if (e.eligible) assert.deepEqual([e.to, e.version, e.grantedAt], ["ada@example.com", "v1", T]);
  const s = decideMarketing(base({ channel: "sms" }));
  assert.equal(s.eligible && s.to, "+447700900123");
});

test("no record, a withdrawal, or anything unclear is NO permission", () => {
  assert.deepEqual(decideMarketing(base({ newest: null })), { eligible: false, channel: "email", reason: "never_consented" });
  assert.deepEqual(decideMarketing(base({ newest: { granted: false, createdAt: T, version: "v1" } })), { eligible: false, channel: "email", reason: "withdrawn" });
  assert.equal(decideMarketing(base({ newest: { granted: "yes" as unknown as boolean, createdAt: T, version: "v1" } })).eligible, false, "a non-boolean grant is not a grant");
  assert.equal(decideMarketing(base({ user: null })).eligible, false);
});

test("staff and deactivated accounts are never marketed to, and SMS needs a number", () => {
  for (const role of ["USER", "ADMIN", "SUPER_ADMIN"]) assert.deepEqual(decideMarketing(base({ user: { ...customer, role } })), { eligible: false, channel: "email", reason: "not_customer" });
  assert.deepEqual(decideMarketing(base({ user: { ...customer, active: false } })), { eligible: false, channel: "email", reason: "inactive" });
  assert.deepEqual(decideMarketing(base({ channel: "sms", phone: null })), { eligible: false, channel: "sms", reason: "no_destination" });
  assert.deepEqual(decideMarketing(base({ channel: "sms", phone: "  " })), { eligible: false, channel: "sms", reason: "no_destination" });
});

test("one channel's decision never depends on the other: the inputs carry only that channel's record", () => {
  // Email granted, SMS never: asking about SMS with no record is a no even though email is a yes.
  assert.equal(decideMarketing(base({ channel: "email" })).eligible, true);
  assert.equal(decideMarketing(base({ channel: "sms", newest: null })).eligible, false);
});

test("the customer's name for the Super Admin list prefers their saved name, then the account name", () => {
  assert.equal(customerDisplayName("Acc Name", { firstName: "Ada", surname: "Lovelace" }), "Ada Lovelace");
  assert.equal(customerDisplayName("Acc Name", { firstName: null, surname: "Lovelace" }), "Lovelace");
  assert.equal(customerDisplayName("Acc Name", null), "Acc Name");
  assert.equal(customerDisplayName("", null), "(no name)");
});
