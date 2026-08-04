/**
 * Integration tests confirming the wiring in lib/custom-domain-health.ts:
 * - sendOrgAlert is called with the right kind ("customDomainAlerts") and the
 *   branding URL includes SITE_URL when an active healthy domain starts failing;
 * - toggle-off and no-recipient orgs receive nothing;
 * - a second pass on the same domain (already-failing) sends no duplicate.
 *
 * Resend is stubbed via global fetch; no real email is sent.
 * checkCustomDomain performs real DNS: the seeded domain is a guaranteed-fail
 * label under .invalid (RFC 2606) so the probe always returns an error.
 *
 * Run alone (never in a parallel `npm test` against next dev):
 *   node --test tests/custom-domain-health-integration.test.mjs
 */
import { register } from "node:module";
register("./helpers/server-lib-loader.mjs", import.meta.url);

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

// Fake credentials so org-alerts and admin-alert paths don't short-circuit.
process.env.RESEND_API_KEY ||= "re_test_fake_key";
// SITE_URL is computed at lib/site.ts load time from NEXT_PUBLIC_SITE_URL.
// lib/site.ts is dynamically imported inside notifyOrg so setting this before
// the first runCustomDomainHealthPass call is sufficient.
process.env.NEXT_PUBLIC_SITE_URL = "https://test.mogulforge.example";

// Unset admin-digest recipient so the admin alert path skips silently and
// only the per-org Resend call remains (easier to assert one recipient).
const savedDigestTo = process.env.LEAD_DIGEST_TO;
delete process.env.LEAD_DIGEST_TO;

// ---- Intercept all Resend calls; block real delivery. ----------------------
const sentEmails = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (url.includes("api.resend.com")) {
    sentEmails.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: `fake-${sentEmails.length}` }), {
      status: 200,
    });
  }
  return realFetch(input, init);
};

const sendsTo = (address) =>
  sentEmails.filter((e) =>
    (Array.isArray(e.to) ? e.to : [e.to]).includes(address),
  );

// Import after stubs are in place.
const { runCustomDomainHealthPass } = await import(
  "../lib/custom-domain-health.ts"
);

const RUN = `dh${Date.now().toString(36)}`;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

// A domain under .invalid always fails DNS (RFC 2606).
const FAIL_DOMAIN = `test-cron-health-${RUN}.invalid`;

const email = (tag) => `${tag}-${RUN}@domain-health-test.local`;

async function createOrg(suffix, notifications) {
  const { rows } = await db.query(
    `INSERT INTO organizations (name, slug, settings)
     VALUES ($1, $2, $3) RETURNING id`,
    [
      `DH Test ${suffix}`,
      `test-dh-${RUN}-${suffix}`,
      JSON.stringify({ notifications }),
    ],
  );
  return rows[0].id;
}

/** Seed an active healthy domain with last_checked_at old enough to be picked up. */
async function seedActiveDomain(orgId, domainOverride) {
  const domainName = domainOverride ?? FAIL_DOMAIN;
  const token = `tkn-${RUN}-${Math.random().toString(36).slice(2)}`;
  const { rows } = await db.query(
    `INSERT INTO custom_domains
       (organization_id, domain, verification_token, status, last_check_error, last_checked_at)
     VALUES ($1, $2, $3, 'active', NULL, now() - interval '2 hours')
     RETURNING id`,
    [orgId, domainName, token],
  );
  return rows[0].id;
}

before(async () => {
  await db.connect();
  await db.query("DELETE FROM organizations WHERE slug LIKE 'test-dh-%'");
});

after(async () => {
  await db.query("DELETE FROM organizations WHERE slug LIKE 'test-dh-%'");
  await db.end();
  globalThis.fetch = realFetch;
  if (savedDigestTo !== undefined) process.env.LEAD_DIGEST_TO = savedDigestTo;
});

// ---------------------------------------------------------------------------

test("active healthy domain → failing: org email sent once, correct subject and branding URL", async () => {
  const to = email("on");
  const orgId = await createOrg("on", {
    customDomainAlerts: true,
    notificationEmails: [to],
  });
  await seedActiveDomain(orgId);

  const baseline = sentEmails.length;
  const result = await runCustomDomainHealthPass();

  // At least one regression was detected for our org.
  assert.ok(result.regressions >= 1, `expected ≥1 regression, got ${result.regressions}`);
  assert.ok(result.orgAlertsSent >= 1, `expected ≥1 orgAlertsSent, got ${result.orgAlertsSent}`);

  const orgSends = sendsTo(to);
  assert.equal(orgSends.length, 1, "org should receive exactly one email");

  const { subject, html } = orgSends[0];
  assert.match(subject, new RegExp(FAIL_DOMAIN.replace(".", "\\.")), "subject should name the failing domain");
  assert.match(html, /dashboard\/revenue-rescue\/branding/, "html should link to branding page");
  assert.match(html, /test\.mogulforge\.example/, "branding URL must be built from SITE_URL");

  // Confirm at least one email was captured overall since baseline.
  assert.ok(sentEmails.length > baseline, "at least one Resend call recorded");
});

test("second pass on already-failing domain sends no duplicate alert", async () => {
  const to = email("nodup");
  const orgId = await createOrg("nodup", {
    customDomainAlerts: true,
    notificationEmails: [to],
  });
  await seedActiveDomain(orgId, `nodup-${RUN}.invalid`);

  // First pass — domain is healthy→failing, sends the alert.
  await runCustomDomainHealthPass();
  const afterFirst = sendsTo(to).length;
  assert.equal(afterFirst, 1, "first pass should send one alert");

  // Second pass — domain is now already-failing; the DB records last_check_error
  // and last_checked_at was just updated so it won't even be selected.
  await runCustomDomainHealthPass();
  assert.equal(
    sendsTo(to).length,
    afterFirst,
    "second pass must not send a duplicate alert",
  );
});

test("toggle-off org: domain fails but no email sent", async () => {
  const to = email("off");
  const orgId = await createOrg("off", {
    customDomainAlerts: false,
    notificationEmails: [to],
  });
  await seedActiveDomain(orgId, `toggle-off-${RUN}.invalid`);

  await runCustomDomainHealthPass();
  assert.equal(
    sendsTo(to).length,
    0,
    "customDomainAlerts=false must suppress the org email",
  );
});

test("no-recipient org: domain fails but no email sent", async () => {
  const to = email("norec");
  const orgId = await createOrg("norec", {
    customDomainAlerts: true,
    notificationEmails: [],
  });
  await seedActiveDomain(orgId, `no-recip-${RUN}.invalid`);

  await runCustomDomainHealthPass();
  assert.equal(
    sendsTo(to).length,
    0,
    "empty notificationEmails must suppress the org email",
  );
});
