/**
 * Integration tests for OUTBOUND per-org calendar routing: booking an
 * appointment must land on the org's OWN calendar when the org has connected
 * its own Google account (org bearer token to googleapis), fall back to the
 * workspace Replit connector only when the org has NO connection of its own,
 * and — critically — a broken/undecryptable org connection must produce a
 * logged failure, never a silent fallback that pushes a client's bookings to
 * the platform owner's calendar.
 *
 * Uses the real database; stubs global fetch (googleapis/graph) and the
 * connectors SDK (tests/helpers/connectors-mock-loader.mjs) so no real
 * calendar call goes out and the workspace connector is fully controllable.
 *
 * Run alone (never in a parallel `npm test` against next dev):
 *   node --test tests/org-calendar-push-routing.test.mjs
 */
import { register } from "node:module";
register("./helpers/server-lib-loader.mjs", import.meta.url);
register("./helpers/connectors-mock-loader.mjs", import.meta.url);

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

process.env.SESSION_SECRET ||= "push-routing-test-secret";

// ---- Workspace connector mock (google-calendar connected & healthy) ----
const connectorCalls = [];
globalThis.__connectorsMock = {
  async listConnections() {
    return [{ connector_name: "google-calendar", status: "connected" }];
  },
  async proxy(connector, path, options) {
    connectorCalls.push({ connector, path, method: options?.method ?? "GET" });
    if ((options?.method ?? "GET") === "POST") {
      return new Response(JSON.stringify({ id: `ws-created-${connectorCalls.length}` }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: "ws-evt", status: "confirmed", start: { dateTime: null } }), { status: 200 });
  },
};

// ---- Stub direct Google/Microsoft HTTP (org-token path) ----
const directCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("https://www.googleapis.com/") || url.startsWith("https://graph.microsoft.com/")) {
    directCalls.push({ url, method: init?.method ?? "GET", auth: init?.headers?.Authorization ?? null });
    return new Response(JSON.stringify({ id: `org-created-${directCalls.length}` }), { status: 200 });
  }
  if (url.includes("oauth2.googleapis.com") || url.includes("login.microsoftonline.com")) {
    directCalls.push({ url, method: init?.method ?? "GET", auth: null });
    return new Response(JSON.stringify({ error: "no token endpoint in tests" }), { status: 500 });
  }
  return realFetch(input, init);
};

const { pushAppointmentToCalendar } = await import("../lib/calendar/sync.ts");
const { encryptToken } = await import("../lib/calendar/token-crypto.ts");

const RUN = `calpush${Date.now().toString(36)}`;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const orgIds = [];

async function seedOrg(label) {
  const { rows } = await db.query(
    `INSERT INTO organizations (name, slug, settings)
     VALUES ($1, $2, '{"calendar":{"syncProvider":"google_calendar"}}'::jsonb)
     RETURNING id`,
    [`Cal Push ${label} ${RUN}`, `test-${label}-${RUN}`],
  );
  orgIds.push(rows[0].id);
  return rows[0].id;
}

async function seedAppointment(orgId) {
  const lead = await db.query(
    `INSERT INTO rescue_leads (organization_id, first_name, last_name) VALUES ($1, 'Push', $2) RETURNING id`,
    [orgId, RUN],
  );
  const { rows } = await db.query(
    `INSERT INTO rescue_appointments (organization_id, lead_id, appointment_type, scheduled_start, status)
     VALUES ($1, $2, 'estimate', now() + interval '3 days', 'confirmed') RETURNING id`,
    [orgId, lead.rows[0].id],
  );
  return rows[0].id;
}

async function externalRefOf(apptId) {
  const { rows } = await db.query(
    `SELECT provider, external_event_id, external_credential_source FROM rescue_appointments WHERE id = $1`,
    [apptId],
  );
  return rows[0];
}

before(async () => {
  await db.connect();
});

after(async () => {
  for (const id of orgIds) await db.query(`DELETE FROM organizations WHERE id = $1`, [id]);
  await db.end();
});

test("org with its own connection: push goes to googleapis with the ORG bearer token, ref stored as org-sourced", async () => {
  const orgId = await seedOrg("own");
  await db.query(
    `INSERT INTO org_calendar_connections (organization_id, provider, account_email, access_token_enc, expires_at)
     VALUES ($1, 'google_calendar', 'client@example.com', $2, now() + interval '1 hour')`,
    [orgId, encryptToken(`org-token-${RUN}`)],
  );
  const apptId = await seedAppointment(orgId);
  directCalls.length = 0;
  connectorCalls.length = 0;

  await pushAppointmentToCalendar(orgId, apptId);

  const call = directCalls.find((c) => c.url.includes("/calendar/v3/calendars/primary/events"));
  assert.ok(call, "event create must hit googleapis directly");
  assert.equal(call.method, "POST");
  assert.equal(call.auth, `Bearer org-token-${RUN}`, "must use the org's own bearer token");
  assert.equal(connectorCalls.length, 0, "workspace connector must NOT be touched when the org has its own connection");

  const ref = await externalRefOf(apptId);
  assert.equal(ref.provider, "google_calendar");
  assert.equal(ref.external_credential_source, "org");
  assert.match(ref.external_event_id, /^org-created-/);
});

test("org WITHOUT its own connection: push uses the workspace connector, ref stored as workspace-sourced", async () => {
  const orgId = await seedOrg("noconn");
  const apptId = await seedAppointment(orgId);
  directCalls.length = 0;
  connectorCalls.length = 0;

  await pushAppointmentToCalendar(orgId, apptId);

  const call = connectorCalls.find((c) => c.path.includes("/calendar/v3/calendars/primary/events"));
  assert.ok(call, "event create must go through the connector proxy");
  assert.equal(call.connector, "google-calendar");
  assert.equal(call.method, "POST");
  assert.equal(
    directCalls.filter((c) => c.url.startsWith("https://www.googleapis.com/")).length,
    0,
    "no direct googleapis call without an org token",
  );

  const ref = await externalRefOf(apptId);
  assert.equal(ref.external_credential_source, "workspace");
  assert.match(ref.external_event_id, /^ws-created-/);
});

test("broken (undecryptable) org connection: push fails with a logged error — NEVER falls back to the workspace connector", async () => {
  const orgId = await seedOrg("broken");
  // Tokens encrypted under a DIFFERENT secret (e.g. SESSION_SECRET rotated):
  // decryptToken returns null, and there is no refresh token to recover with.
  await db.query(
    `INSERT INTO org_calendar_connections (organization_id, provider, account_email, access_token_enc, expires_at)
     VALUES ($1, 'google_calendar', 'client@example.com', $2, now() + interval '1 hour')`,
    [orgId, encryptToken("unreadable", "some-other-secret")],
  );
  const apptId = await seedAppointment(orgId);
  directCalls.length = 0;
  connectorCalls.length = 0;

  const logged = [];
  const realError = console.error;
  console.error = (...args) => logged.push(args.map(String).join(" "));
  try {
    await pushAppointmentToCalendar(orgId, apptId);
  } finally {
    console.error = realError;
  }

  assert.equal(connectorCalls.length, 0, "broken org connection must never fall back to the workspace account");
  assert.equal(
    directCalls.filter((c) => c.url.startsWith("https://www.googleapis.com/")).length,
    0,
    "no calendar API call can be made without a decryptable org token",
  );
  assert.ok(
    logged.some((line) => line.includes(`Calendar push failed for appointment ${apptId}`)),
    "the failure must be logged",
  );
  const ref = await externalRefOf(apptId);
  assert.equal(ref.external_event_id, null, "no external event ref may be recorded");
});

test("inbound pull: a workspace-sourced ref is checked via the connector proxy, an org-sourced ref via the org token", async () => {
  const { runCalendarSync } = await import("../lib/calendar/sync.ts");
  const orgWs = await seedOrg("pullws");
  const wsAppt = await seedAppointment(orgWs);
  await db.query(
    `UPDATE rescue_appointments SET provider = 'google_calendar', external_event_id = $2, external_credential_source = 'workspace' WHERE id = $1`,
    [wsAppt, `pull-ws-${RUN}`],
  );
  const orgOwn = await seedOrg("pullorg");
  await db.query(
    `INSERT INTO org_calendar_connections (organization_id, provider, account_email, access_token_enc, expires_at)
     VALUES ($1, 'google_calendar', 'client2@example.com', $2, now() + interval '1 hour')`,
    [orgOwn, encryptToken(`org-token-pull-${RUN}`)],
  );
  const orgAppt = await seedAppointment(orgOwn);
  await db.query(
    `UPDATE rescue_appointments SET provider = 'google_calendar', external_event_id = $2, external_credential_source = 'org' WHERE id = $1`,
    [orgAppt, `pull-org-${RUN}`],
  );
  directCalls.length = 0;
  connectorCalls.length = 0;

  await runCalendarSync();

  const wsCall = connectorCalls.find((c) => c.path.includes(encodeURIComponent(`pull-ws-${RUN}`)));
  assert.ok(wsCall, "workspace-sourced ref must be looked up through the connector proxy");
  assert.equal(wsCall.connector, "google-calendar");
  assert.equal(directCalls.some((c) => c.url.includes(encodeURIComponent(`pull-ws-${RUN}`))), false);

  const orgCall = directCalls.find((c) => c.url.includes(encodeURIComponent(`pull-org-${RUN}`)));
  assert.ok(orgCall, "org-sourced ref must be looked up directly against googleapis");
  assert.equal(orgCall.auth, `Bearer org-token-pull-${RUN}`);
  assert.equal(connectorCalls.some((c) => c.path.includes(encodeURIComponent(`pull-org-${RUN}`))), false);
});
