import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyProfile, normalisePhone, validateProfile } from "../../src/lib/customer/profile";

const ok = (input: Record<string, unknown>) => {
  const r = validateProfile(input);
  assert.ok(r.ok, JSON.stringify(r));
  return r.ok ? r.value : emptyProfile();
};
const bad = (input: Record<string, unknown>) => {
  const r = validateProfile(input);
  assert.ok(!r.ok, "expected errors");
  return r.ok ? {} : r.errors;
};

test("every profile field is optional: an empty submission is valid and stores nothing", () => {
  assert.deepEqual(ok({}), emptyProfile());
});

test("text is cleaned (spaces collapsed, trimmed) and length-limited; angle brackets and control characters are refused", () => {
  assert.equal(ok({ firstName: "  Ada   Lovelace " }).firstName, "Ada Lovelace");
  assert.ok(bad({ surname: "x".repeat(81) }).surname);
  assert.ok(bad({ businessName: "<script>" }).businessName);
  assert.ok(bad({ town: "Lon\u0000don" }).town);
  assert.ok(bad({ address1: 42 }).address1);
});

test("title and country must come from the lists; country is upper-cased", () => {
  assert.equal(ok({ title: "Dr", country: "gb" }).country, "GB");
  assert.ok(bad({ title: "Lord Emperor" }).title);
  assert.ok(bad({ country: "ZZ" }).country);
  assert.ok(bad({ country: "United Kingdom" }).country);
});

test("UK postcodes are checked for shape and normalised; other countries get a looser check", () => {
  assert.equal(ok({ country: "GB", postcode: "sw1a1aa" }).postcode, "SW1A 1AA");
  assert.equal(ok({ country: "GB", postcode: "M1  1AE" }).postcode, "M1 1AE");
  assert.ok(bad({ country: "GB", postcode: "NOTAPOSTCODE" }).postcode);
  assert.ok(bad({ country: "GB", postcode: "12345" }).postcode);
  assert.equal(ok({ country: "US", postcode: "90210" }).postcode, "90210");
  assert.equal(ok({ country: "DE", postcode: "10115" }).postcode, "10115");
  assert.ok(bad({ country: "US", postcode: "!!" }).postcode);
});

test("phone numbers are normalised to E.164, independent of any email address", () => {
  assert.equal(ok({ phone: "07700 900123" }).phone, "+447700900123");
  assert.equal(ok({ phone: "+44 (0)7700 900123".replace("(0)", "") }).phone, "+447700900123");
  assert.equal(ok({ country: "GB", phone: "020 7946 0018" }).phone, "+442079460018");
  assert.equal(ok({ phone: "0044 7700 900123" }).phone, "+447700900123");
  assert.equal(ok({ country: "US", phone: "+1 202-555-0143" }).phone, "+12025550143");
  assert.ok(bad({ phone: "abc" }).phone);
  assert.ok(bad({ phone: "12345" }).phone);
  assert.ok(bad({ phone: "+1" }).phone);
  assert.ok(bad({ country: "US", phone: "202 555 0143" }).phone, "a non-UK number needs its country code");
  assert.equal(normalisePhone("+442079460018", "").ok, true);
});

test("several errors are reported together, one message per field", () => {
  const e = bad({ country: "GB", postcode: "x", phone: "y", title: "zz" });
  assert.deepEqual(Object.keys(e).sort(), ["phone", "postcode", "title"]);
});
