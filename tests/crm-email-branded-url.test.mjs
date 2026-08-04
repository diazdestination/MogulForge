/**
 * Confirms that the CRM outage and recovery alert emails link to the org's
 * branded portal (custom domain) rather than the platform SITE_URL.
 *
 * Strategy:
 * - Seed an org whose only active custom domain is portal.crm-email-test.example
 * - Seed a CRM connection and a rescue lead so recordPushDelivery can insert rows
 * - Drive 5 consecutive failures (ERROR_THRESHOLD_FAILURES) to flip the
 *   connection to 'error' and fire notifyConnectionErrored
 * - Drive 1 success to flip it back to 'active' and fire notifyConnectionRecovered
 * - Assert the integrationsUrl in both emails starts with the custom-domain origin
 *
 * Resend is stubbed via global fetch; no real email is sent.
 * Requires DATABASE_URL. Run alone (not via `npm test`):
 *   node --test tests/crm-email-branded-url.test.mjs
 */
import { register } from "node:module";
register("./helpers/server-lib-loader.mjs", import.meta.url);

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

// Provide a fake Resend key so the send path does not short-circuit.
process.env.RESEND_API_KEY ||= "re_test_fake_key";

// Use a stable SITE_URL so we can confirm emails DON'T use it for branded orgs.
process.env.NEXT_PUBLIC_SITE_URL = "https://platform.mogulforge.example";

// Suppress the admin digest recipient so only per-org Resend calls are captured.
const savedDigestTo = process.env.LEAD_DIGEST_TO;
delete process.env.LEAD_DIGEST_TO;

// ---- Intercept Resend calls; block real delivery. --------------------------
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
const { recordPushDelivery, ERROR_THRESHOLD_FAILURES } = await import(
  "../lib/crm/deliveries.ts"
);
const { getPool } = await import("../lib/db.ts");

// ---------------------------------------------------------------------------

const RUN = `crmburl${Date.now().toString(36)}`;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

const CUSTOM_DOMAIN = `portal.crm-email-test-${RUN}.example`;
const CUSTOM_DOMAIN_ORIGIN = `https://${CUSTOM_DOMAIN}`;
const NOTIFY_EMAIL = `owner-${RUN}@crm-email-branded-test.local`;

const state = {};

async function waitFor(predicate, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 60));
  }
  return predicate();
}

async function cleanup() {
  await db.query("DELETE FROM organizations WHERE slug LIKE 'test-crmburl%'");
}

before(async () => {
  await db.connect();
  await cleanup();

  // Org with crmConnectionAlerts enabled and a notification address.
  const orgRes = await db.query(
    `INSERT INTO organizations (name, slug, settings)
     VALUES ($1, $2, $3) RETURNING id`,
    [
      `CRM Email Branded ${RUN}`,
      `test-crmburl-${RUN}`,
      JSON.stringify({
        notifications: {
          crmConnectionAlerts: true,
          notificationEmails: [NOTIFY_EMAIL],
        },
      }),
    ],
  );
  state.orgId = orgRes.rows[0].id;

  // Active custom domain for this org.
  await db.query(
    `INSERT INTO custom_domains
       (organization_id, domain, verification_token, status, verified_at, activated_at)
     VALUES ($1, $2, $3, 'active', now(), now())`,
    [state.orgId, CUSTOM_DOMAIN, `tok-${RUN}`],
  );

  // CRM connection in 'active' status so the failure counter can flip it to 'error'.
  const connRes = await db.query(
    `INSERT INTO crm_connections
       (organization_id, provider, name, status, config)
     VALUES ($1, 'generic_webhook', 'Branded URL Test CRM', 'active', '{"url":"http://127.0.0.1/crm"}')
     RETURNING id`,
    [state.orgId],
  );
  state.connId = connRes.rows[0].id;

  // A rescue lead so crm_push_deliveries FK is satisfied.
  const leadRes = await db.query(
    `INSERT INTO rescue_leads
       (organization_id, first_name, last_name, consent_status, suppressed, pipeline_stage)
     VALUES ($1, 'Branded', 'Lead', 'express', false, 'imported') RETURNING id`,
    [state.orgId],
  );
  state.leadId = leadRes.rows[0].id;
});

after(async () => {
  await cleanup();
  await db.end();
  await getPool().end();
  globalThis.fetch = realFetch;
  if (savedDigestTo !== undefined) process.env.LEAD_DIGEST_TO = savedDigestTo;
});

// ---------------------------------------------------------------------------

test("outage email links to the branded portal, not the platform URL", async () => {
  const baseline = sentEmails.length;

  // Drive exactly ERROR_THRESHOLD_FAILURES consecutive failures.
  // The threshold flip happens when count reaches 5 AND status is still 'active'.
  for (let i = 0; i < ERROR_THRESHOLD_FAILURES; i++) {
    await recordPushDelivery(state.orgId, {
      connectionId: state.connId,
      leadId: state.leadId,
      provider: "generic_webhook",
      ok: false,
      statusCode: 500,
      message: "simulated CRM outage",
    });
  }

  // Wait for the fire-and-forget alert to land in sentEmails.
  const ok = await waitFor(() => sendsTo(NOTIFY_EMAIL).length > baseline);
  assert.ok(ok, "outage alert email was not sent within the timeout");

  const orgSends = sendsTo(NOTIFY_EMAIL).slice(baseline);
  assert.equal(orgSends.length, 1, "exactly one outage alert should be sent");

  const { subject, html } = orgSends[0];
  assert.match(subject, /paused/i, "outage subject should mention the connection being paused");
  assert.ok(
    html.includes(CUSTOM_DOMAIN_ORIGIN),
    `outage email integrationsUrl must start with ${CUSTOM_DOMAIN_ORIGIN} — got:\n${html}`,
  );
  assert.ok(
    !html.includes("platform.mogulforge.example"),
    "outage email must not fall back to the platform SITE_URL",
  );
  assert.match(html, /dashboard\/revenue-rescue\/integrations/, "URL must point at the integrations page");
});

test("recovery email links to the branded portal, not the platform URL", async () => {
  const baseline = sendsTo(NOTIFY_EMAIL).length;

  // One success flips the connection from 'error' back to 'active' and fires recovery.
  await recordPushDelivery(state.orgId, {
    connectionId: state.connId,
    leadId: state.leadId,
    provider: "generic_webhook",
    ok: true,
    statusCode: 200,
    message: "ok",
  });

  const ok = await waitFor(() => sendsTo(NOTIFY_EMAIL).length > baseline);
  assert.ok(ok, "recovery alert email was not sent within the timeout");

  const newSends = sendsTo(NOTIFY_EMAIL).slice(baseline);
  assert.equal(newSends.length, 1, "exactly one recovery alert should be sent");

  const { subject, html } = newSends[0];
  assert.match(subject, /recovered/i, "recovery subject should mention the connection recovering");
  assert.ok(
    html.includes(CUSTOM_DOMAIN_ORIGIN),
    `recovery email integrationsUrl must start with ${CUSTOM_DOMAIN_ORIGIN} — got:\n${html}`,
  );
  assert.ok(
    !html.includes("platform.mogulforge.example"),
    "recovery email must not fall back to the platform SITE_URL",
  );
  assert.match(html, /dashboard\/revenue-rescue\/integrations/, "URL must point at the integrations page");
});
