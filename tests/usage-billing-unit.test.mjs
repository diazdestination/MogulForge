/**
 * Unit tests for the pure usage/plan/branding/domain logic:
 *   - billing period keys and limit normalization (incl. legacy keys)
 *   - warning thresholds (75/90/100) and threshold crossings
 *   - the server-side usage gate math
 *   - account states blocking gated actions
 *   - branding resolution with white-label entitlement enforcement
 *   - custom-domain normalization and activation gating
 *
 * Pure lib imports only — no server or DB required.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  usagePeriodFor,
  normalizeLimits,
  effectiveLimits,
  usagePercent,
  warningLevel,
  crossedThresholds,
  evaluateGate,
  accountBlocksGatedActions,
  isLimitExempt,
} from "../lib/usage-metrics.ts";
import { resolveBranding } from "../lib/branding-core.ts";
import {
  normalizeDomain,
  requiredDnsRecords,
  txtRecordsContainToken,
  canActivateDomain,
  normalizeHostHeader,
  platformHostsFromEnv,
  isPlatformHost,
} from "../lib/custom-domain-core.ts";

// ---------------------------------------------------------------------------
// Periods & limits
// ---------------------------------------------------------------------------

test("usagePeriodFor produces UTC YYYY-MM keys", () => {
  assert.equal(usagePeriodFor(new Date("2026-08-01T00:00:00Z")), "2026-08");
  assert.equal(usagePeriodFor(new Date("2026-12-31T23:59:59Z")), "2026-12");
  // Local-time trap: just before midnight UTC on Jan 31 is still January.
  assert.equal(usagePeriodFor(new Date("2026-01-31T23:30:00Z")), "2026-01");
});

test("normalizeLimits maps legacy provisioning keys and drops junk", () => {
  const limits = normalizeLimits({
    leads_per_month: 1000,
    ai_analyses_per_month: "50",
    sms_per_month: 200.9,
    emails_per_month: 300,
    seats: 5,
    api_requests: 10000,
    unknown_key: 42,
    leads_imported: -5, // negative → dropped
    messages_generated: "not-a-number",
  });
  assert.deepEqual(limits, {
    leads_imported: 1000,
    ai_jobs: 50,
    sms_sent: 200,
    emails_sent: 300,
    seats: 5,
    api_requests: 10000,
  });
});

test("effectiveLimits lets org overrides win per key", () => {
  const merged = effectiveLimits({ leads_imported: 1000, ai_jobs: 50 }, { ai_jobs: 500 });
  assert.deepEqual(merged, { leads_imported: 1000, ai_jobs: 500 });
});

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

test("usagePercent and warningLevel honor 75/90/100 thresholds", () => {
  assert.equal(usagePercent(0, null), null);
  assert.equal(warningLevel(999999, null), null); // unlimited never warns
  assert.equal(warningLevel(74, 100), null);
  assert.equal(warningLevel(75, 100), 75);
  assert.equal(warningLevel(90, 100), 90);
  assert.equal(warningLevel(99, 100), 90);
  assert.equal(warningLevel(100, 100), 100);
  assert.equal(warningLevel(250, 100), 100);
  // zero limit: any use = 100%
  assert.equal(warningLevel(1, 0), 100);
  assert.equal(warningLevel(0, 0), null);
});

test("crossedThresholds reports only newly crossed thresholds", () => {
  assert.deepEqual(crossedThresholds(70, 74, 100), []);
  assert.deepEqual(crossedThresholds(70, 80, 100), [75]);
  assert.deepEqual(crossedThresholds(80, 95, 100), [90]);
  assert.deepEqual(crossedThresholds(50, 120, 100), [75, 90, 100]);
  assert.deepEqual(crossedThresholds(95, 96, 100), []); // already past 90
  assert.deepEqual(crossedThresholds(0, 10, null), []); // unlimited
});

// ---------------------------------------------------------------------------
// Gate math
// ---------------------------------------------------------------------------

test("evaluateGate allows unlimited, enforces exact remaining capacity", () => {
  assert.equal(evaluateGate(1000000, null, 50).allowed, true);
  assert.equal(evaluateGate(90, 100, 10).allowed, true); // exactly fills the limit
  assert.equal(evaluateGate(90, 100, 11).allowed, false);
  const decision = evaluateGate(95, 100, 10);
  assert.equal(decision.allowed, false);
  assert.equal(decision.remaining, 5);
  assert.equal(evaluateGate(0, 0, 1).allowed, false); // zero limit blocks
});

// ---------------------------------------------------------------------------
// Account states
// ---------------------------------------------------------------------------

test("accountBlocksGatedActions blocks suspended/cancelled/expired trials only", () => {
  const now = new Date("2026-08-01T12:00:00Z");
  assert.equal(accountBlocksGatedActions("active", null, now).blocked, false);
  assert.equal(accountBlocksGatedActions("past_due", null, now).blocked, false);
  assert.equal(accountBlocksGatedActions("internal", null, now).blocked, false);
  assert.equal(accountBlocksGatedActions("suspended", null, now).blocked, true);
  assert.equal(accountBlocksGatedActions("cancelled", null, now).blocked, true);
  assert.equal(accountBlocksGatedActions("trialing", "2026-09-01T00:00:00Z", now).blocked, false);
  assert.equal(accountBlocksGatedActions("trialing", "2026-07-01T00:00:00Z", now).blocked, true);
  assert.equal(accountBlocksGatedActions("trialing", null, now).blocked, false); // open-ended trial
});

test("isLimitExempt only for internal accounts", () => {
  assert.equal(isLimitExempt("internal"), true);
  assert.equal(isLimitExempt("active"), false);
  assert.equal(isLimitExempt("suspended"), false);
});

// ---------------------------------------------------------------------------
// Branding resolution & white-label entitlement
// ---------------------------------------------------------------------------

const baseOrg = {
  name: "Acme Roofing",
  brandingLevel: "white_label",
  displayName: "Acme Exteriors",
  logoUrl: "https://cdn.acme.com/logo.png",
  brandPrimaryColor: "#ff6600",
  brandSecondaryColor: "not-a-color",
  portalTitle: "Acme Client Portal",
  loginTitle: null,
  supportEmail: "help@acme.com",
  supportPhone: null,
  emailSenderName: null,
  smsSenderName: "ACME",
  poweredByLabel: null,
};

test("white_label without entitlement downgrades to powered_by", () => {
  const branding = resolveBranding(baseOrg, false);
  assert.equal(branding.level, "powered_by");
  assert.equal(branding.requestedLevel, "white_label");
  assert.deepEqual(branding.poweredBy, { show: true, label: "Powered by MogulForge" });
  // Custom look still applies at powered_by
  assert.equal(branding.displayName, "Acme Exteriors");
  assert.equal(branding.primaryColor, "#ff6600");
  assert.equal(branding.secondaryColor, null); // invalid hex rejected
});

test("white_label with entitlement hides powered-by unless a label is set", () => {
  const branding = resolveBranding(baseOrg, true);
  assert.equal(branding.level, "white_label");
  assert.equal(branding.poweredBy.show, false);
  const labeled = resolveBranding({ ...baseOrg, poweredByLabel: "Built on Acme Tech" }, true);
  assert.deepEqual(labeled.poweredBy, { show: true, label: "Built on Acme Tech" });
});

test("mogulforge level ignores custom identity entirely", () => {
  const branding = resolveBranding({ ...baseOrg, brandingLevel: "mogulforge" }, true);
  assert.equal(branding.level, "mogulforge");
  assert.equal(branding.displayName, "Acme Roofing"); // org name, not display name
  assert.equal(branding.logoUrl, null);
  assert.equal(branding.primaryColor, null);
  assert.deepEqual(branding.poweredBy, { show: true, label: "MogulForge" });
});

test("sender names fall back to the display name", () => {
  const branding = resolveBranding(baseOrg, true);
  assert.equal(branding.emailSenderName, "Acme Exteriors");
  assert.equal(branding.smsSenderName, "ACME");
});

// ---------------------------------------------------------------------------
// Custom domains
// ---------------------------------------------------------------------------

test("normalizeDomain cleans input and rejects bad hosts", () => {
  assert.equal(normalizeDomain(" https://Portal.Acme.COM/path?q=1 "), "portal.acme.com");
  assert.equal(normalizeDomain("portal.acme.com:8443"), "portal.acme.com");
  assert.equal(normalizeDomain("localhost"), null);
  assert.equal(normalizeDomain("*.acme.com"), null);
  assert.equal(normalizeDomain("192.168.1.1"), null);
  assert.equal(normalizeDomain(""), null);
  assert.equal(normalizeDomain("-bad-.acme.com"), null);
});

test("required DNS records include verification TXT and routing CNAME", () => {
  const records = requiredDnsRecords("portal.acme.com", "tok123", "app.mogulforge.example");
  const txt = records.find((r) => r.type === "TXT");
  const cname = records.find((r) => r.type === "CNAME");
  assert.equal(txt.name, "_mogulforge-verify.portal.acme.com");
  assert.equal(txt.value, "mogulforge-verify=tok123");
  assert.equal(cname.name, "portal.acme.com");
  assert.equal(cname.value, "app.mogulforge.example");
});

test("txtRecordsContainToken matches chunked TXT values exactly", () => {
  assert.equal(txtRecordsContainToken([["mogulforge-verify=tok123"]], "tok123"), true);
  assert.equal(txtRecordsContainToken([["mogulforge-", "verify=tok123"]], "tok123"), true); // chunked
  assert.equal(txtRecordsContainToken([["mogulforge-verify=other"]], "tok123"), false);
  assert.equal(txtRecordsContainToken([], "tok123"), false);
});

test("canActivateDomain requires verification and uniqueness", () => {
  assert.equal(canActivateDomain({ status: "pending_dns", domain: "a.com" }, []).ok, false);
  assert.equal(canActivateDomain({ status: "active", domain: "a.com" }, []).ok, false);
  assert.equal(canActivateDomain({ status: "verified", domain: "a.com" }, ["A.COM"]).ok, false); // case-insensitive clash
  assert.equal(canActivateDomain({ status: "verified", domain: "a.com" }, ["b.com"]).ok, true);
});

// ---------------------------------------------------------------------------
// Custom-domain host routing (host-header normalization + platform detection)
// ---------------------------------------------------------------------------

test("normalizeHostHeader lowercases, strips port, and rejects literals", () => {
  assert.equal(normalizeHostHeader("Portal.Acme.COM:443"), "portal.acme.com");
  assert.equal(normalizeHostHeader(" portal.acme.com , other.example.com"), "portal.acme.com");
  assert.equal(normalizeHostHeader("portal.acme.com."), "portal.acme.com");
  assert.equal(normalizeHostHeader("[::1]:5000"), null);
  assert.equal(normalizeHostHeader(""), null);
  assert.equal(normalizeHostHeader(null), null);
});

test("isPlatformHost recognizes platform hosts and never treats them as custom domains", () => {
  const platform = platformHostsFromEnv({
    REPLIT_DOMAINS: "My-App.Replit.app, staging.example.com",
    REPLIT_DEV_DOMAIN: "abc.picard.replit.dev",
    CUSTOM_DOMAIN_CNAME_TARGET: "portal-target.mogulforge.com",
  });
  for (const host of [
    "localhost", "sub.localhost", "127.0.0.1", "10.0.0.5", "::1",
    "my-app.replit.app", "abc.picard.replit.dev", "anything.replit.dev",
    "staging.example.com", "portal-target.mogulforge.com",
  ]) {
    assert.equal(isPlatformHost(host, platform), true, host);
  }
  assert.equal(isPlatformHost("portal.acme.com", platform), false);
  assert.equal(isPlatformHost("portal.mogulforge.com", platform), false);
});
