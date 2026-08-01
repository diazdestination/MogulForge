/**
 * Unit tests for the pure public-API/webhook/embed/CRM libraries:
 * - webhook HMAC signatures: verify, tamper, replay window
 * - embed tokens: issue/verify, expiry, tamper, origin allow-list (incl. wildcards)
 * - CRM field mapping: transforms, validation errors, applied output
 * - fixed-window rate limiter behavior
 *
 * These import the .ts modules directly (no server needed).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { signWebhookPayload, verifyWebhookSignature } from "../lib/webhooks/signature.ts";
import { issueEmbedToken, verifyEmbedToken, originAllowed, normalizeOrigin } from "../lib/embed/tokens.ts";
import { applyTransform, validateFieldMapping, applyFieldMapping, SAMPLE_LEAD } from "../lib/crm/mapping.ts";
import { FixedWindowRateLimiter } from "../lib/public-api/rate-limit.ts";

const SECRET = "test_secret_123";
const NOW = 1_800_000_000; // fixed unix seconds for determinism

test("webhook signature: round-trip verifies", () => {
  const body = JSON.stringify({ id: "evt_1", type: "ping", data: {} });
  const sig = signWebhookPayload(SECRET, NOW, body);
  assert.match(sig, /^v1=[0-9a-f]{64}$/);
  const check = verifyWebhookSignature({
    secret: SECRET,
    rawBody: body,
    signatureHeader: sig,
    timestampHeader: String(NOW),
    nowSeconds: NOW,
  });
  assert.deepEqual(check, { valid: true });
});

test("webhook signature: tampered body is rejected", () => {
  const body = JSON.stringify({ id: "evt_1", type: "ping" });
  const sig = signWebhookPayload(SECRET, NOW, body);
  const check = verifyWebhookSignature({
    secret: SECRET,
    rawBody: body.replace("ping", "pong"),
    signatureHeader: sig,
    timestampHeader: String(NOW),
    nowSeconds: NOW,
  });
  assert.equal(check.valid, false);
  assert.equal(check.reason, "signature_mismatch");
});

test("webhook signature: wrong secret is rejected", () => {
  const body = "{}";
  const sig = signWebhookPayload("other_secret", NOW, body);
  const check = verifyWebhookSignature({ secret: SECRET, rawBody: body, signatureHeader: sig, timestampHeader: String(NOW), nowSeconds: NOW });
  assert.equal(check.valid, false);
  assert.equal(check.reason, "signature_mismatch");
});

test("webhook signature: replay outside the tolerance window is rejected (both directions)", () => {
  const body = "{}";
  for (const skew of [301, -301]) {
    const ts = NOW - skew;
    const sig = signWebhookPayload(SECRET, ts, body);
    const check = verifyWebhookSignature({ secret: SECRET, rawBody: body, signatureHeader: sig, timestampHeader: String(ts), nowSeconds: NOW });
    assert.equal(check.valid, false, `skew ${skew}`);
    assert.equal(check.reason, "timestamp_out_of_tolerance");
  }
  // Just inside the window passes.
  const ts = NOW - 299;
  const okCheck = verifyWebhookSignature({
    secret: SECRET,
    rawBody: body,
    signatureHeader: signWebhookPayload(SECRET, ts, body),
    timestampHeader: String(ts),
    nowSeconds: NOW,
  });
  assert.equal(okCheck.valid, true);
});

test("webhook signature: missing / invalid headers", () => {
  const body = "{}";
  assert.equal(verifyWebhookSignature({ secret: SECRET, rawBody: body, signatureHeader: null, timestampHeader: String(NOW), nowSeconds: NOW }).reason, "missing_signature");
  assert.equal(verifyWebhookSignature({ secret: SECRET, rawBody: body, signatureHeader: "v1=abc", timestampHeader: null, nowSeconds: NOW }).reason, "missing_timestamp");
  assert.equal(verifyWebhookSignature({ secret: SECRET, rawBody: body, signatureHeader: "v1=abc", timestampHeader: "not-a-number", nowSeconds: NOW }).reason, "invalid_timestamp");
});

test("embed token: issue + verify carries all claims", () => {
  const { token, claims } = issueEmbedToken(
    { organizationId: "org_1", userId: "crm-77", role: "editor", modules: ["dashboard", "lead_form"], origin: "https://client.example.com", ttlSeconds: 900 },
    { secret: SECRET, nowSeconds: NOW },
  );
  assert.equal(claims.exp, NOW + 900);
  const check = verifyEmbedToken(token, { secret: SECRET, nowSeconds: NOW + 100 });
  assert.equal(check.valid, true);
  assert.equal(check.claims.org, "org_1");
  assert.equal(check.claims.uid, "crm-77");
  assert.equal(check.claims.role, "editor");
  assert.deepEqual(check.claims.modules, ["dashboard", "lead_form"]);
  assert.equal(check.claims.origin, "https://client.example.com");
});

test("embed token: expired tokens are rejected; TTL is clamped to one hour", () => {
  const { token } = issueEmbedToken({ organizationId: "org_1", modules: ["dashboard"], origin: "https://a.com", ttlSeconds: 60 }, { secret: SECRET, nowSeconds: NOW });
  assert.equal(verifyEmbedToken(token, { secret: SECRET, nowSeconds: NOW + 61 }).reason, "expired");

  const { claims } = issueEmbedToken({ organizationId: "org_1", modules: ["dashboard"], origin: "https://a.com", ttlSeconds: 86_400 }, { secret: SECRET, nowSeconds: NOW });
  assert.equal(claims.exp - claims.iat, 3600, "TTL must clamp to the 1 hour maximum");
});

test("embed token: tampered payload or wrong secret fails", () => {
  const { token } = issueEmbedToken({ organizationId: "org_1", modules: ["dashboard"], origin: "https://a.com" }, { secret: SECRET, nowSeconds: NOW });
  const [payload, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), org: "org_2" })).toString("base64url");
  assert.equal(verifyEmbedToken(`${forged}.${sig}`, { secret: SECRET, nowSeconds: NOW }).valid, false);
  assert.equal(verifyEmbedToken(token, { secret: "different", nowSeconds: NOW }).valid, false);
  assert.equal(verifyEmbedToken("garbage", { secret: SECRET, nowSeconds: NOW }).reason, "malformed");
});

test("origin allow-list: exact match, wildcard subdomains, localhost leniency", () => {
  const allowed = ["https://www.client.com", "*.agency.io", "http://localhost:3000"];
  assert.equal(originAllowed("https://www.client.com", allowed), true);
  assert.equal(originAllowed("https://evil.com", allowed), false);
  assert.equal(originAllowed("https://client.com", allowed), false, "exact entries do not cover other subdomains");
  assert.equal(originAllowed("https://sites.agency.io", allowed), true, "wildcard covers subdomains");
  assert.equal(originAllowed("https://agency.io", allowed), false, "wildcard does not cover the apex");
  assert.equal(originAllowed("https://notagency.io", allowed), false);
  assert.equal(originAllowed("http://localhost:3000", allowed), true);
  assert.equal(originAllowed("https://localhost:3000", allowed), true, "scheme leniency only for localhost");
  assert.equal(normalizeOrigin("ftp://x.com"), null);
  assert.equal(normalizeOrigin("https://X.com/path?a=1"), "https://x.com");
});

test("mapping transforms behave as labeled", () => {
  assert.equal(applyTransform("titlecase", "JORDAN RIVERA"), "Jordan Rivera");
  assert.equal(applyTransform("digits_only", "(555) 201-7788"), "5552017788");
  assert.equal(applyTransform("e164_us", "(555) 201-7788"), "+15552017788");
  assert.equal(applyTransform("e164_us", "1 555 201 7788"), "+15552017788");
  assert.equal(applyTransform("number", "14500"), 14500);
  assert.equal(applyTransform("number", "not-a-number"), null);
  assert.equal(applyTransform("full_name", null, { firstName: "Jordan", lastName: "Rivera" }), "Jordan Rivera");
  assert.equal(applyTransform("full_name", null, { firstName: "", lastName: "" }), null);
  assert.equal(applyTransform("uppercase", null), null, "null stays null");
});

test("field mapping validation catches bad rows without throwing", () => {
  const { mapping, errors } = validateFieldMapping([
    { source: "email", target: "Email", transform: "lowercase" },
    { source: "not_a_field", target: "x", transform: "none" },
    { source: "phone", target: "", transform: "none" },
    { source: "firstName", target: "Email", transform: "none" }, // duplicate target
    { source: "lastName", target: "last", transform: "bogus_transform" }, // falls back to none
  ]);
  assert.equal(mapping.length, 2);
  assert.equal(errors.length, 3);
  assert.equal(mapping[1].transform, "none");
  assert.deepEqual(validateFieldMapping("nope").errors, ["Field mapping must be an array."]);
});

test("applyFieldMapping produces the external payload from a lead", () => {
  const output = applyFieldMapping(
    [
      { source: "email", target: "contact_email", transform: "lowercase" },
      { source: "phone", target: "contact_phone", transform: "e164_us" },
      { source: "firstName", target: "full_name", transform: "full_name" },
      { source: "estimatedValue", target: "value", transform: "number" },
    ],
    SAMPLE_LEAD,
  );
  assert.deepEqual(output, {
    contact_email: "jordan.rivera@example.com",
    contact_phone: "+15552017788",
    full_name: "Jordan Rivera",
    value: 14500,
  });
});

test("fixed-window rate limiter enforces the per-window cap and resets", () => {
  const limiter = new FixedWindowRateLimiter(3, 60_000);
  const t0 = 1_800_000_000_000; // aligned enough for a single window
  assert.equal(limiter.check("k", t0).allowed, true);
  assert.equal(limiter.check("k", t0 + 1).allowed, true);
  const third = limiter.check("k", t0 + 2);
  assert.equal(third.allowed, true);
  assert.equal(third.remaining, 0);
  assert.equal(limiter.check("k", t0 + 3).allowed, false, "4th call in window is limited");
  assert.equal(limiter.check("other", t0 + 4).allowed, true, "keys are independent");
  assert.equal(limiter.check("k", t0 + 60_000).allowed, true, "next window resets the counter");
});
