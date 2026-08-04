/**
 * Integration tests for per-org calendar credential routing (task: per-org
 * Google/Outlook OAuth). The rule under test: every synced appointment is
 * checked/updated with the SAME credentials that created its external event
 * (stored external_credential_source) — connecting or disconnecting an org
 * account must never flip the lookup to a different account, because a false
 * 404 there would mass-cancel valid appointments.
 *
 * Uses the real database; stubs global fetch so no Google/Microsoft call goes
 * out. The workspace Replit connector is unavailable in the test process
 * (no connector env), so workspace-sourced refs must be SKIPPED, not 404'd.
 *
 * Run alone (never in a parallel `npm test` against next dev):
 *   node --test tests/org-calendar-routing.test.mjs
 */
import { register } from "node:module";
register("./helpers/server-lib-loader.mjs", import.meta.url);

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

process.env.SESSION_SECRET ||= "routing-test-secret";

// ---- Stub outbound calendar API calls ----
const calls = [];
let googleEventResponse = () => new Response(JSON.stringify({ error: "not found" }), { status: 404 });
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("https://www.googleapis.com/")) {
    calls.push({ url, auth: init?.headers?.Authorization ?? null });
    return googleEventResponse(url);
  }
  if (url.startsWith("https://graph.microsoft.com/") || url.includes("oauth2.googleapis.com") || url.includes("login.microsoftonline.com")) {
    calls.push({ url });
    return new Response(JSON.stringify({}), { status: 500 });
  }
  // Force the workspace Replit connector to look unavailable: the connector
  // module treats a failed lookup as honestly "not connected".
  if (url.includes("connector")) {
    return new Response("unavailable in test", { status: 503 });
  }
  return realFetch(input, init);
};

const { runCalendarSync } = await import("../lib/calendar/sync.ts");
const { encryptToken } = await import("../lib/calendar/token-crypto.ts");

const RUN = `calrt${Date.now().toString(36)}`;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
let orgId, leadId;

before(async () => {
  await db.connect();
  orgId = (await db.query(
    `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
    [`Cal Routing ${RUN}`, `test-${RUN}`],
  )).rows[0].id;
  leadId = (await db.query(
    `INSERT INTO rescue_leads (organization_id, first_name, last_name) VALUES ($1, 'Cal', $2) RETURNING id`,
    [orgId, RUN],
  )).rows[0].id;
});

after(async () => {
  await db.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
  await db.end();
});

async function seedAppointment(externalEventId, source) {
  const { rows } = await db.query(
    `INSERT INTO rescue_appointments
       (organization_id, lead_id, appointment_type, scheduled_start, status, provider, external_event_id, external_credential_source)
     VALUES ($1, $2, 'estimate', now() + interval '2 days', 'confirmed', 'google_calendar', $3, $4)
     RETURNING id`,
    [orgId, leadId, externalEventId, source],
  );
  return rows[0].id;
}

async function statusOf(id) {
  return (await db.query(`SELECT status FROM rescue_appointments WHERE id = $1`, [id])).rows[0].status;
}

test("workspace-sourced event is NOT checked via a newly connected org account (no false cancel)", async () => {
  // Pre-existing appointment synced under the workspace connector.
  const apptId = await seedAppointment(`ws-event-${RUN}`, "workspace");
  // Org then connects its own Google account.
  await db.query(
    `INSERT INTO org_calendar_connections (organization_id, provider, account_email, access_token_enc, expires_at)
     VALUES ($1, 'google_calendar', 'client@example.com', $2, now() + interval '1 hour')`,
    [orgId, encryptToken("org-access-token")],
  );
  calls.length = 0;
  await runCalendarSync();
  // The workspace connector is unavailable here, so the ref must be skipped —
  // never looked up under the org's token (which would 404 → false cancel).
  assert.equal(calls.some((c) => c.url.includes(`ws-event-${RUN}`)), false);
  assert.equal(await statusOf(apptId), "confirmed");
});

test("org-sourced event is checked with the org token, and 404 there cancels it", async () => {
  const apptId = await seedAppointment(`org-event-${RUN}`, "org");
  calls.length = 0;
  await runCalendarSync();
  const call = calls.find((c) => c.url.includes(encodeURIComponent(`org-event-${RUN}`)));
  assert.ok(call, "org-sourced event must be looked up");
  assert.equal(call.auth, "Bearer org-access-token");
  assert.equal(await statusOf(apptId), "cancelled");
});

test("org-sourced event is skipped (not flipped to workspace) after the org disconnects", async () => {
  const apptId = await seedAppointment(`orphan-event-${RUN}`, "org");
  await db.query(`DELETE FROM org_calendar_connections WHERE organization_id = $1`, [orgId]);
  calls.length = 0;
  await runCalendarSync();
  assert.equal(calls.some((c) => c.url.includes(`orphan-event-${RUN}`)), false);
  assert.equal(await statusOf(apptId), "confirmed");
});
