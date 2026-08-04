/**
 * Integration tests proving org alert emails always respect each org's saved
 * notification toggles and addresses (Settings → Notifications):
 * - sendOrgAlert skips when the toggle is off or the address list is empty
 *   (no fallback recipient), for reply, hot-lead, and appointment kinds;
 * - processInboundReply's fire-and-forget alert honors the same gating;
 * - runOrgWeeklyDigests sends at most once per org per week, and honors force.
 *
 * Imports the server lib directly (loader stubs "server-only") and records
 * outbound Resend calls by stubbing global fetch — no real email is sent.
 * Requires DATABASE_URL; RESEND_API_KEY is faked for the test process.
 *
 * Run alone (never in a parallel `npm test` against next dev):
 *   node --test tests/org-alerts-gating.test.mjs
 */
import { register } from "node:module";
register("./helpers/server-lib-loader.mjs", import.meta.url);

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

process.env.RESEND_API_KEY ||= "re_test_fake_key";

// ---- Record outbound Resend sends; block any accidental real delivery. ----
const sentEmails = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.includes("api.resend.com")) {
    sentEmails.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: `fake-${sentEmails.length}` }), { status: 200 });
  }
  return realFetch(input, init);
};
const sendsTo = (address) => sentEmails.filter((e) => (Array.isArray(e.to) ? e.to : [e.to]).includes(address));

const { sendOrgAlert, runOrgWeeklyDigests } = await import("../lib/org-alerts.ts");
const { buildReplyAlertEmail } = await import("../lib/org-alerts-content.ts");
const { processInboundReply } = await import("../lib/rescue-engage/reply-service.ts");

const RUN = `alrt${Date.now().toString(36)}`;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

async function createOrg(suffix, notifications) {
  const { rows } = await db.query(
    `INSERT INTO organizations (name, slug, settings)
     VALUES ($1, $2, $3) RETURNING id`,
    [`Alert Test ${suffix}`, `test-${RUN}-${suffix}`, JSON.stringify({ notifications })],
  );
  return rows[0].id;
}

async function seedLead(orgId) {
  const { rows } = await db.query(
    `INSERT INTO rescue_leads (organization_id, first_name, last_name, consent_status, suppressed, score, category, analysis_status, pipeline_stage)
     VALUES ($1, 'Lead', $2, 'express', false, 60, 'worth_reengaging', 'analyzed', 'analyzed') RETURNING id`,
    [orgId, RUN],
  );
  return rows[0].id;
}

async function waitFor(predicate, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

const email = (tag) => `${tag}-${RUN}@alerts-test.local`;
const sampleAlert = buildReplyAlertEmail({ orgName: "T", leadName: "L", replyBody: "hi", channel: "sms", categoryLabel: "Question" });

before(async () => {
  await db.connect();
  await db.query("DELETE FROM organizations WHERE slug LIKE 'test-alrt%'");
});

after(async () => {
  await db.query("DELETE FROM organizations WHERE slug LIKE 'test-alrt%'");
  await db.end();
  globalThis.fetch = realFetch;
});

test("sendOrgAlert: toggle off → skipped, nothing sent (all alert kinds)", async () => {
  const orgId = await createOrg("off", {
    hotLeadAlerts: false, replyAlerts: false, appointmentAlerts: false, weeklyDigest: false,
    notificationEmails: [email("off")],
  });
  for (const kind of ["replyAlerts", "hotLeadAlerts", "appointmentAlerts", "weeklyDigest"]) {
    const result = await sendOrgAlert(orgId, kind, sampleAlert);
    assert.deepEqual(result, { status: "skipped", reason: "toggle_off" }, kind);
  }
  assert.equal(sendsTo(email("off")).length, 0);
});

test("sendOrgAlert: no saved addresses → skipped, no fallback recipient", async () => {
  const orgId = await createOrg("noaddr", {
    hotLeadAlerts: true, replyAlerts: true, appointmentAlerts: true, weeklyDigest: true,
    notificationEmails: [],
  });
  const baseline = sentEmails.length;
  for (const kind of ["replyAlerts", "hotLeadAlerts", "appointmentAlerts"]) {
    const result = await sendOrgAlert(orgId, kind, sampleAlert);
    assert.deepEqual(result, { status: "skipped", reason: "no_recipients" }, kind);
  }
  assert.equal(sentEmails.length, baseline, "no email may go out without a saved address");
});

test("sendOrgAlert: toggle on + saved address → sent exactly to the saved list", async () => {
  const to = email("on");
  const orgId = await createOrg("on", {
    hotLeadAlerts: true, replyAlerts: true, appointmentAlerts: true, weeklyDigest: false,
    notificationEmails: [to],
  });
  const result = await sendOrgAlert(orgId, "replyAlerts", sampleAlert);
  assert.deepEqual(result, { status: "sent", to: [to] });
  assert.equal(sendsTo(to).length, 1);
});

test("processInboundReply: reply alert honors the toggle", async () => {
  const offOrg = await createOrg("replyoff", {
    hotLeadAlerts: true, replyAlerts: false, appointmentAlerts: true, weeklyDigest: false,
    notificationEmails: [email("replyoff")],
  });
  await processInboundReply({
    organizationId: offOrg, leadId: await seedLead(offOrg),
    channel: "sms", body: "what is this about?", actorUserId: null,
  });

  const onOrg = await createOrg("replyon", {
    hotLeadAlerts: false, replyAlerts: true, appointmentAlerts: true, weeklyDigest: false,
    notificationEmails: [email("replyon")],
  });
  await processInboundReply({
    organizationId: onOrg, leadId: await seedLead(onOrg),
    channel: "sms", body: "what is this about?", actorUserId: null,
  });

  // The alert is fire-and-forget: wait for the enabled org's send to land,
  // which also proves the disabled org's (earlier) event produced nothing.
  assert.ok(await waitFor(() => sendsTo(email("replyon")).length === 1), "enabled org should receive a reply alert");
  assert.equal(sendsTo(email("replyoff")).length, 0, "toggle off must suppress the reply alert");
});

test("processInboundReply: hot reply uses the hot-lead toggle, not the reply toggle", async () => {
  const orgId = await createOrg("hotoff", {
    hotLeadAlerts: false, replyAlerts: true, appointmentAlerts: true, weeklyDigest: false,
    notificationEmails: [email("hotoff")],
  });
  const outcome = await processInboundReply({
    organizationId: orgId, leadId: await seedLead(orgId),
    channel: "sms", body: "Yes, I'm interested! Call me", actorUserId: null,
  });
  assert.equal(outcome.category === "interested" || outcome.category === "wants_appointment", true);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(sendsTo(email("hotoff")).length, 0, "hot-lead toggle off must suppress the alert even with replyAlerts on");
});

test("runOrgWeeklyDigests sends once per week per org, honors force", async () => {
  const to = email("digest");
  const orgId = await createOrg("digest", {
    hotLeadAlerts: true, replyAlerts: true, appointmentAlerts: true, weeklyDigest: true,
    notificationEmails: [to],
  });
  await seedLead(orgId); // recent activity so the digest has something to report

  const first = await runOrgWeeklyDigests();
  assert.deepEqual(first.find((o) => o.organizationId === orgId), { organizationId: orgId, status: "sent" });
  assert.equal(sendsTo(to).length, 1);

  const second = await runOrgWeeklyDigests();
  assert.deepEqual(second.find((o) => o.organizationId === orgId), {
    organizationId: orgId, status: "skipped", reason: "already_sent_this_week",
  });
  assert.equal(sendsTo(to).length, 1, "no second digest within the same week");

  await seedLead(orgId); // fresh activity since last_sent_at = now
  const forced = await runOrgWeeklyDigests({ force: true });
  assert.deepEqual(forced.find((o) => o.organizationId === orgId), { organizationId: orgId, status: "sent" });
  assert.equal(sendsTo(to).length, 2, "force sends again despite the weekly window");
});

test("runOrgWeeklyDigests skips quiet weeks instead of emailing an empty report", async () => {
  const orgId = await createOrg("digquiet", {
    hotLeadAlerts: true, replyAlerts: true, appointmentAlerts: true, weeklyDigest: true,
    notificationEmails: [email("digquiet")],
  });
  const outcomes = await runOrgWeeklyDigests();
  assert.deepEqual(outcomes.find((o) => o.organizationId === orgId), {
    organizationId: orgId, status: "skipped", reason: "no_activity",
  });
  assert.equal(sendsTo(email("digquiet")).length, 0);
});

test("runOrgWeeklyDigests never selects orgs with the toggle off or no addresses", async () => {
  const offOrg = await createOrg("digoff", {
    hotLeadAlerts: true, replyAlerts: true, appointmentAlerts: true, weeklyDigest: false,
    notificationEmails: [email("digoff")],
  });
  const emptyOrg = await createOrg("digempty", {
    hotLeadAlerts: true, replyAlerts: true, appointmentAlerts: true, weeklyDigest: true,
    notificationEmails: [],
  });
  await seedLead(offOrg);
  await seedLead(emptyOrg);
  const outcomes = await runOrgWeeklyDigests({ force: true });
  assert.equal(outcomes.some((o) => o.organizationId === offOrg), false);
  assert.equal(outcomes.some((o) => o.organizationId === emptyOrg), false);
  assert.equal(sendsTo(email("digoff")).length, 0);
});
