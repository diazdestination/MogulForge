/**
 * Unit tests for lead-intake normalisation and duplicate / suppression
 * phone-matching behaviour (last-10-digits country-code tolerance).
 *
 * Pure lib imports — no server or database required.
 */
import { register } from "node:module";
register("./helpers/server-lib-loader.mjs", import.meta.url);

import { test } from "node:test";
import assert from "node:assert/strict";

// Dynamic import so the server-lib-loader hook is active before resolution.
const { normalizePhone, normalizeEmail, parseLeadIntake } = await import("../lib/public-api/lead-intake.ts");

// ---------------------------------------------------------------------------
// normalizePhone
// ---------------------------------------------------------------------------

test("normalizePhone: 10-digit number stays as-is", () => {
  assert.equal(normalizePhone("5556449001"), "5556449001");
});

test("normalizePhone: strips formatting characters", () => {
  assert.equal(normalizePhone("(555) 644-9001"), "5556449001");
});

test("normalizePhone: +1 country code is kept in the normalized string", () => {
  // The raw digits are stored; last-10-digit comparison resolves the match later.
  assert.equal(normalizePhone("+1 555 644 9001"), "15556449001");
});

test("normalizePhone: fewer than 10 digits returns null", () => {
  assert.equal(normalizePhone("12345"), null);
  assert.equal(normalizePhone(""), null);
  assert.equal(normalizePhone(null), null);
});

// ---------------------------------------------------------------------------
// Last-10-digits equivalence (the core dedup guarantee)
// ---------------------------------------------------------------------------

test("last-10-digits: 10-digit and +1-prefixed variants share the same suffix", () => {
  const tenDigit = normalizePhone("(555) 644-9001");   // "5556449001"
  const withCode = normalizePhone("+1 555 644 9001");  // "15556449001"

  assert.ok(tenDigit, "10-digit normalises");
  assert.ok(withCode, "+1 variant normalises");

  // The DB query uses RIGHT(phone_normalized, 10); emulate that here.
  assert.equal(tenDigit.slice(-10), withCode.slice(-10),
    "+1-prefixed and plain 10-digit numbers must share the same last-10-digit suffix");
});

test("last-10-digits: different numbers do NOT share the same suffix", () => {
  const a = normalizePhone("5556449001");
  const b = normalizePhone("5556449002");
  assert.notEqual(a.slice(-10), b.slice(-10));
});

// ---------------------------------------------------------------------------
// normalizeEmail
// ---------------------------------------------------------------------------

test("normalizeEmail: lowercases and trims", () => {
  assert.equal(normalizeEmail("  Test@Example.COM  "), "test@example.com");
});

test("normalizeEmail: rejects malformed addresses", () => {
  assert.equal(normalizeEmail("not-an-email"), null);
  assert.equal(normalizeEmail(""), null);
  assert.equal(normalizeEmail(null), null);
});

// ---------------------------------------------------------------------------
// parseLeadIntake
// ---------------------------------------------------------------------------

test("parseLeadIntake: accepts a minimal payload with only a phone", () => {
  const { input, message } = parseLeadIntake({ phone: "+1 555 644 9001" });
  assert.ok(input, message);
  assert.equal(input.phone, "+1 555 644 9001");
});

test("parseLeadIntake: rejects a payload with no email and no phone", () => {
  const { input, message } = parseLeadIntake({ firstName: "Jordan" });
  assert.equal(input, null);
  assert.ok(message);
});

test("parseLeadIntake: rejects an out-of-range estimatedValue", () => {
  const { input, message } = parseLeadIntake({ email: "a@b.com", estimatedValue: -5 });
  assert.equal(input, null);
  assert.ok(message);
});
