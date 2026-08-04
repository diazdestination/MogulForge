/**
 * Unit tests for parseGrantedScopes (lib/discovery/signals/gbp-signal.ts).
 * Ensures the DB column (space-delimited string) is correctly parsed into
 * an array of scope strings — the regression this guards is treating it as
 * a JS array (Array.isArray → always false for a DB string → empty granted).
 *
 * Run alone: node --test tests/gbp-signal-scope-parsing.test.mjs
 */
import { register } from "node:module";
register("./helpers/server-lib-loader.mjs", import.meta.url);

import { test } from "node:test";
import assert from "node:assert/strict";

const { parseGrantedScopes } = await import("../lib/discovery/signals/gbp-scope.ts");

const GBP_SCOPE = "https://www.googleapis.com/auth/business.manage";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

test("parses a single scope from a space-delimited string", () => {
  const result = parseGrantedScopes(GBP_SCOPE);
  assert.deepEqual(result, [GBP_SCOPE]);
});

test("parses multiple scopes separated by spaces", () => {
  const result = parseGrantedScopes(`${CALENDAR_SCOPE} ${GBP_SCOPE}`);
  assert.ok(result.includes(GBP_SCOPE), "GBP scope must be present");
  assert.ok(result.includes(CALENDAR_SCOPE), "calendar scope must be present");
  assert.equal(result.length, 2);
});

test("returns empty array for null", () => {
  assert.deepEqual(parseGrantedScopes(null), []);
});

test("returns empty array for undefined", () => {
  assert.deepEqual(parseGrantedScopes(undefined), []);
});

test("returns empty array for empty string", () => {
  assert.deepEqual(parseGrantedScopes(""), []);
});

test("returns empty array for whitespace-only string", () => {
  assert.deepEqual(parseGrantedScopes("   "), []);
});

test("handles leading/trailing whitespace in the stored value", () => {
  const result = parseGrantedScopes(`  ${GBP_SCOPE}  `);
  assert.deepEqual(result, [GBP_SCOPE]);
});

test("defensively handles a legacy array value", () => {
  const result = parseGrantedScopes([GBP_SCOPE, CALENDAR_SCOPE]);
  assert.ok(result.includes(GBP_SCOPE));
  assert.ok(result.includes(CALENDAR_SCOPE));
});

test("GBP scope present → includes() check succeeds", () => {
  const granted = parseGrantedScopes(`${CALENDAR_SCOPE} ${GBP_SCOPE}`);
  assert.ok(granted.includes(GBP_SCOPE), "granted.includes(GBP_SCOPE) must be true");
});

test("GBP scope absent → includes() check returns false", () => {
  const granted = parseGrantedScopes(CALENDAR_SCOPE);
  assert.equal(granted.includes(GBP_SCOPE), false);
});
