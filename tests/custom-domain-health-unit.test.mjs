import test from "node:test";
import assert from "node:assert/strict";
import {
  runDomainHealthPass,
  buildDomainRegressionEmail,
} from "../lib/custom-domain-health-core.ts";

function domain(overrides = {}) {
  return {
    id: "d1",
    organizationId: "o1",
    organizationName: "Acme Roofing",
    domain: "portal.acme.com",
    status: "active",
    lastCheckError: null,
    ...overrides,
  };
}

function makeDeps({
  domains = [],
  outcomes = {},
  sendFails = false,
  orgSendFails = false,
  orgSkips = false,
  orgRecoveryFails = false,
  orgRecoverySkips = false,
} = {}) {
  const calls = { checked: [], alerts: [], orgAlerts: [], orgRecoveryAlerts: [] };
  return {
    calls,
    deps: {
      listMonitoredDomains: async () => domains,
      checkDomain: async (orgId, domainId) => {
        calls.checked.push(domainId);
        const outcome = outcomes[domainId];
        if (outcome instanceof Error) throw outcome;
        return outcome === undefined ? { ok: true, message: "Routing is live." } : outcome;
      },
      sendAlert: async (alert) => {
        if (sendFails) throw new Error("resend down");
        calls.alerts.push(alert);
      },
      notifyOrg: async (alert) => {
        if (orgSendFails) throw new Error("resend down");
        if (orgSkips) return false;
        calls.orgAlerts.push(alert);
        return true;
      },
      notifyOrgRecovery: async (alert) => {
        if (orgRecoveryFails) throw new Error("resend down");
        if (orgRecoverySkips) return false;
        calls.orgRecoveryAlerts.push(alert);
        return true;
      },
    },
  };
}

// --- regression (healthy → failing) tests ---

test("healthy domains: checked, no alerts", async () => {
  const { deps, calls } = makeDeps({ domains: [domain(), domain({ id: "d2", domain: "app.beta.com" })] });
  const result = await runDomainHealthPass(deps);
  assert.deepEqual(result, { checked: 2, failing: 0, regressions: 0, alertsSent: 0, orgAlertsSent: 0, recoveries: 0, orgRecoveryAlertsSent: 0 });
  assert.deepEqual(calls.checked, ["d1", "d2"]);
  assert.equal(calls.alerts.length, 0);
});

test("active domain flipping healthy -> failing sends one alert", async () => {
  const { deps, calls } = makeDeps({
    domains: [domain()],
    outcomes: { d1: { ok: false, message: "The CNAME record points at wrong.example.com." } },
  });
  const result = await runDomainHealthPass(deps);
  assert.deepEqual(result, { checked: 1, failing: 1, regressions: 1, alertsSent: 1, orgAlertsSent: 1, recoveries: 0, orgRecoveryAlertsSent: 0 });
  assert.equal(calls.alerts[0].domain, "portal.acme.com");
  assert.match(calls.alerts[0].message, /wrong\.example\.com/);
});

test("already-failing domain does not re-alert", async () => {
  const { deps, calls } = makeDeps({
    domains: [domain({ lastCheckError: "CNAME missing" })],
    outcomes: { d1: { ok: false, message: "Still broken." } },
  });
  const result = await runDomainHealthPass(deps);
  assert.deepEqual(result, { checked: 1, failing: 1, regressions: 0, alertsSent: 0, orgAlertsSent: 0, recoveries: 0, orgRecoveryAlertsSent: 0 });
  assert.equal(calls.alerts.length, 0);
});

test("verified-but-not-active domain records failure without alerting", async () => {
  const { deps, calls } = makeDeps({
    domains: [domain({ status: "verified" })],
    outcomes: { d1: { ok: false, message: "No CNAME yet." } },
  });
  const result = await runDomainHealthPass(deps);
  assert.deepEqual(result, { checked: 1, failing: 1, regressions: 0, alertsSent: 0, orgAlertsSent: 0, recoveries: 0, orgRecoveryAlertsSent: 0 });
  assert.equal(calls.alerts.length, 0);
});

test("one probe throwing does not stop the pass", async () => {
  const { deps } = makeDeps({
    domains: [domain(), domain({ id: "d2", domain: "app.beta.com" })],
    outcomes: { d1: new Error("dns exploded") },
  });
  const result = await runDomainHealthPass(deps);
  assert.deepEqual(result, { checked: 1, failing: 0, regressions: 0, alertsSent: 0, orgAlertsSent: 0, recoveries: 0, orgRecoveryAlertsSent: 0 });
});

test("removed-between-list-and-check (null outcome) is skipped", async () => {
  const { deps } = makeDeps({ domains: [domain()], outcomes: { d1: null } });
  const result = await runDomainHealthPass(deps);
  assert.deepEqual(result, { checked: 0, failing: 0, regressions: 0, alertsSent: 0, orgAlertsSent: 0, recoveries: 0, orgRecoveryAlertsSent: 0 });
});

test("alert send failure is swallowed but counted as regression", async () => {
  const { deps } = makeDeps({
    domains: [domain()],
    outcomes: { d1: { ok: false, message: "Broken." } },
    sendFails: true,
  });
  const result = await runDomainHealthPass(deps);
  assert.deepEqual(result, { checked: 1, failing: 1, regressions: 1, alertsSent: 0, orgAlertsSent: 1, recoveries: 0, orgRecoveryAlertsSent: 0 });
});

test("healthy -> failing also notifies the owning org", async () => {
  const { deps, calls } = makeDeps({
    domains: [domain()],
    outcomes: { d1: { ok: false, message: "The CNAME record points at wrong.example.com." } },
  });
  await runDomainHealthPass(deps);
  assert.equal(calls.orgAlerts.length, 1);
  assert.deepEqual(calls.orgAlerts[0], {
    organizationId: "o1",
    organizationName: "Acme Roofing",
    domain: "portal.acme.com",
    message: "The CNAME record points at wrong.example.com.",
  });
});

test("already-failing domain does not re-notify the org", async () => {
  const { deps, calls } = makeDeps({
    domains: [domain({ lastCheckError: "CNAME missing" })],
    outcomes: { d1: { ok: false, message: "Still broken." } },
  });
  await runDomainHealthPass(deps);
  assert.equal(calls.orgAlerts.length, 0);
});

test("org notification skipped by settings is not counted as sent", async () => {
  const { deps, calls } = makeDeps({
    domains: [domain()],
    outcomes: { d1: { ok: false, message: "Broken." } },
    orgSkips: true,
  });
  const result = await runDomainHealthPass(deps);
  assert.equal(result.orgAlertsSent, 0);
  assert.equal(result.alertsSent, 1);
  assert.equal(calls.orgAlerts.length, 0);
});

test("org notification failure is swallowed and does not block the admin alert", async () => {
  const { deps, calls } = makeDeps({
    domains: [domain()],
    outcomes: { d1: { ok: false, message: "Broken." } },
    orgSendFails: true,
  });
  const result = await runDomainHealthPass(deps);
  assert.deepEqual(result, { checked: 1, failing: 1, regressions: 1, alertsSent: 1, orgAlertsSent: 0, recoveries: 0, orgRecoveryAlertsSent: 0 });
  assert.equal(calls.alerts.length, 1);
});

test("admin alert failure does not block the org notification", async () => {
  const { deps, calls } = makeDeps({
    domains: [domain()],
    outcomes: { d1: { ok: false, message: "Broken." } },
    sendFails: true,
  });
  const result = await runDomainHealthPass(deps);
  assert.equal(result.orgAlertsSent, 1);
  assert.equal(calls.orgAlerts.length, 1);
});

// --- recovery (failing → healthy) tests ---

test("active domain flipping failing -> healthy sends one org recovery alert", async () => {
  const { deps, calls } = makeDeps({
    domains: [domain({ lastCheckError: "CNAME missing" })],
    // default outcome is ok:true
  });
  const result = await runDomainHealthPass(deps);
  assert.deepEqual(result, { checked: 1, failing: 0, regressions: 0, alertsSent: 0, orgAlertsSent: 0, recoveries: 1, orgRecoveryAlertsSent: 1 });
  assert.equal(calls.orgRecoveryAlerts.length, 1);
  assert.deepEqual(calls.orgRecoveryAlerts[0], {
    organizationId: "o1",
    organizationName: "Acme Roofing",
    domain: "portal.acme.com",
  });
});

test("always-healthy domain does not send a recovery alert", async () => {
  const { deps, calls } = makeDeps({
    domains: [domain({ lastCheckError: null })],
    // default outcome is ok:true
  });
  const result = await runDomainHealthPass(deps);
  assert.equal(result.recoveries, 0);
  assert.equal(result.orgRecoveryAlertsSent, 0);
  assert.equal(calls.orgRecoveryAlerts.length, 0);
});

test("non-active domain recovering does not send a recovery alert", async () => {
  const { deps, calls } = makeDeps({
    domains: [domain({ status: "verified", lastCheckError: "old error" })],
    // default outcome is ok:true
  });
  const result = await runDomainHealthPass(deps);
  assert.equal(result.recoveries, 0);
  assert.equal(result.orgRecoveryAlertsSent, 0);
  assert.equal(calls.orgRecoveryAlerts.length, 0);
});

test("recovery org notification skipped by settings is not counted as sent", async () => {
  const { deps, calls } = makeDeps({
    domains: [domain({ lastCheckError: "CNAME missing" })],
    orgRecoverySkips: true,
  });
  const result = await runDomainHealthPass(deps);
  assert.equal(result.recoveries, 1);
  assert.equal(result.orgRecoveryAlertsSent, 0);
  assert.equal(calls.orgRecoveryAlerts.length, 0);
});

test("recovery org notification failure is swallowed and does not stop the pass", async () => {
  const { deps, calls } = makeDeps({
    domains: [domain({ lastCheckError: "CNAME missing" }), domain({ id: "d2", domain: "app.beta.com", lastCheckError: "old error" })],
    orgRecoveryFails: true,
  });
  const result = await runDomainHealthPass(deps);
  assert.equal(result.checked, 2);
  assert.equal(result.recoveries, 2);
  assert.equal(result.orgRecoveryAlertsSent, 0);
});

// --- email content tests ---

test("client-facing error email names the record problem and links the branding page", async () => {
  const { buildCustomDomainErrorEmail } = await import("../lib/org-alerts-content.ts");
  const { subject, html } = buildCustomDomainErrorEmail({
    orgName: "Acme Roofing",
    domain: "portal.acme.com",
    message: "The CNAME record points at wrong.example.com.",
    brandingUrl: "https://app.example.com/dashboard/revenue-rescue/branding",
  });
  assert.match(subject, /portal\.acme\.com/);
  assert.match(html, /wrong\.example\.com/);
  assert.match(html, /dashboard\/revenue-rescue\/branding/);
  assert.match(html, /CNAME/);
});

test("client-facing recovery email confirms healthy status and links the branding page", async () => {
  const { buildCustomDomainRecoveredEmail } = await import("../lib/org-alerts-content.ts");
  const { subject, html } = buildCustomDomainRecoveredEmail({
    orgName: "Acme Roofing",
    domain: "portal.acme.com",
    brandingUrl: "https://app.example.com/dashboard/revenue-rescue/branding",
  });
  assert.match(subject, /portal\.acme\.com/);
  assert.match(html, /working again|restored|healthy/i);
  assert.match(html, /dashboard\/revenue-rescue\/branding/);
});

test("regression email names the domain, org, and details", () => {
  const { subject, html } = buildDomainRegressionEmail({
    domain: "portal.acme.com",
    organizationName: "Acme Roofing",
    message: "The CNAME record points at nothing.",
  });
  assert.match(subject, /portal\.acme\.com/);
  assert.match(html, /Acme Roofing/);
  assert.match(html, /CNAME record points at nothing/);
});
