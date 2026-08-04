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

function makeDeps({ domains = [], outcomes = {}, sendFails = false } = {}) {
  const calls = { checked: [], alerts: [] };
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
    },
  };
}

test("healthy domains: checked, no alerts", async () => {
  const { deps, calls } = makeDeps({ domains: [domain(), domain({ id: "d2", domain: "app.beta.com" })] });
  const result = await runDomainHealthPass(deps);
  assert.deepEqual(result, { checked: 2, failing: 0, regressions: 0, alertsSent: 0 });
  assert.deepEqual(calls.checked, ["d1", "d2"]);
  assert.equal(calls.alerts.length, 0);
});

test("active domain flipping healthy -> failing sends one alert", async () => {
  const { deps, calls } = makeDeps({
    domains: [domain()],
    outcomes: { d1: { ok: false, message: "The CNAME record points at wrong.example.com." } },
  });
  const result = await runDomainHealthPass(deps);
  assert.deepEqual(result, { checked: 1, failing: 1, regressions: 1, alertsSent: 1 });
  assert.equal(calls.alerts[0].domain, "portal.acme.com");
  assert.match(calls.alerts[0].message, /wrong\.example\.com/);
});

test("already-failing domain does not re-alert", async () => {
  const { deps, calls } = makeDeps({
    domains: [domain({ lastCheckError: "CNAME missing" })],
    outcomes: { d1: { ok: false, message: "Still broken." } },
  });
  const result = await runDomainHealthPass(deps);
  assert.deepEqual(result, { checked: 1, failing: 1, regressions: 0, alertsSent: 0 });
  assert.equal(calls.alerts.length, 0);
});

test("verified-but-not-active domain records failure without alerting", async () => {
  const { deps, calls } = makeDeps({
    domains: [domain({ status: "verified" })],
    outcomes: { d1: { ok: false, message: "No CNAME yet." } },
  });
  const result = await runDomainHealthPass(deps);
  assert.deepEqual(result, { checked: 1, failing: 1, regressions: 0, alertsSent: 0 });
  assert.equal(calls.alerts.length, 0);
});

test("one probe throwing does not stop the pass", async () => {
  const { deps } = makeDeps({
    domains: [domain(), domain({ id: "d2", domain: "app.beta.com" })],
    outcomes: { d1: new Error("dns exploded") },
  });
  const result = await runDomainHealthPass(deps);
  assert.deepEqual(result, { checked: 1, failing: 0, regressions: 0, alertsSent: 0 });
});

test("removed-between-list-and-check (null outcome) is skipped", async () => {
  const { deps } = makeDeps({ domains: [domain()], outcomes: { d1: null } });
  const result = await runDomainHealthPass(deps);
  assert.deepEqual(result, { checked: 0, failing: 0, regressions: 0, alertsSent: 0 });
});

test("alert send failure is swallowed but counted as regression", async () => {
  const { deps } = makeDeps({
    domains: [domain()],
    outcomes: { d1: { ok: false, message: "Broken." } },
    sendFails: true,
  });
  const result = await runDomainHealthPass(deps);
  assert.deepEqual(result, { checked: 1, failing: 1, regressions: 1, alertsSent: 0 });
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
