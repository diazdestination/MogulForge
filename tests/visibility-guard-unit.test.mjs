import test from "node:test";
import assert from "node:assert/strict";
import {
  isDisposableEmail,
  clientIpFromHeaders,
  createVisibilityLimiters,
  checkScanRequest,
} from "../lib/visibility-guard.ts";

test("isDisposableEmail flags known throwaway providers", () => {
  assert.equal(isDisposableEmail("bot@mailinator.com"), true);
  assert.equal(isDisposableEmail("bot@MAILINATOR.COM"), true);
  assert.equal(isDisposableEmail("bot@sub.yopmail.com"), true);
  assert.equal(isDisposableEmail("owner@acmeroofing.com"), false);
  assert.equal(isDisposableEmail("person@gmail.com"), false);
});

test("clientIpFromHeaders prefers first x-forwarded-for hop", () => {
  const h = new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1", "x-real-ip": "10.0.0.1" });
  assert.equal(clientIpFromHeaders(h), "203.0.113.9");
  assert.equal(clientIpFromHeaders(new Headers({ "x-real-ip": "198.51.100.4" })), "198.51.100.4");
  assert.equal(clientIpFromHeaders(new Headers()), "unknown");
});

test("disposable email rejected before consuming rate limit", async () => {
  const limiters = createVisibilityLimiters({});
  const verdict = await checkScanRequest(limiters, { ip: "1.2.3.4", email: "x@yopmail.com" });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.status, 400);
});

test("per-IP throttle kicks in after configured limit", async () => {
  const limiters = createVisibilityLimiters({ VISIBILITY_SCAN_IP_LIMIT: "2", VISIBILITY_SCAN_EMAIL_LIMIT: "100" });
  const now = 1_800_000_000_000;
  assert.equal((await checkScanRequest(limiters, { ip: "1.1.1.1", email: "a@example.com" }, now)).allowed, true);
  assert.equal((await checkScanRequest(limiters, { ip: "1.1.1.1", email: "b@example.com" }, now)).allowed, true);
  const third = await checkScanRequest(limiters, { ip: "1.1.1.1", email: "c@example.com" }, now);
  assert.equal(third.allowed, false);
  assert.equal(third.status, 429);
  assert.ok(third.retryAfterSeconds >= 1);
  // A different IP is unaffected.
  assert.equal((await checkScanRequest(limiters, { ip: "2.2.2.2", email: "d@example.com" }, now)).allowed, true);
});

test("per-email throttle is case-insensitive and IP-independent", async () => {
  const limiters = createVisibilityLimiters({ VISIBILITY_SCAN_IP_LIMIT: "100", VISIBILITY_SCAN_EMAIL_LIMIT: "2" });
  const now = 1_800_000_000_000;
  assert.equal((await checkScanRequest(limiters, { ip: "1.1.1.1", email: "Same@Example.com" }, now)).allowed, true);
  assert.equal((await checkScanRequest(limiters, { ip: "2.2.2.2", email: "same@example.com" }, now)).allowed, true);
  const third = await checkScanRequest(limiters, { ip: "3.3.3.3", email: "SAME@example.com " }, now);
  assert.equal(third.allowed, false);
  assert.equal(third.status, 429);
});

test("throttle resets after the window passes", async () => {
  const limiters = createVisibilityLimiters({ VISIBILITY_SCAN_IP_LIMIT: "1", VISIBILITY_SCAN_EMAIL_LIMIT: "1" });
  const now = 1_800_000_000_000;
  assert.equal((await checkScanRequest(limiters, { ip: "9.9.9.9", email: "z@example.com" }, now)).allowed, true);
  assert.equal((await checkScanRequest(limiters, { ip: "9.9.9.9", email: "z@example.com" }, now + 1000)).allowed, false);
  assert.equal((await checkScanRequest(limiters, { ip: "9.9.9.9", email: "z@example.com" }, now + 11 * 60_000)).allowed, true);
});
