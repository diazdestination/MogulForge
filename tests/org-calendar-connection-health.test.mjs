/**
 * Integration tests for org calendar connection health tracking (task: warn
 * clients when their own calendar connection stops syncing). Rules under test:
 * - repeated token-refresh failures increment refresh_failure_count and flip
 *   status to 'error' at the threshold (instead of erroring forever)
 * - the flip sends ONE alert email to the org's saved notification addresses
 * - reconnecting (OAuth code exchange upsert) resets status back to 'active'
 *
 * Uses the real database; stubs global fetch so no Google/Resend call goes out.
 *
 * Run alone (never in a parallel `npm test` against next dev):
 *   node --test tests/org-calendar-connection-health.test.mjs
 */
import { register } from "node:module";
register("./helpers/server-lib-loader.mjs", import.meta.url);

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

process.env.SESSION_SECRET ||= "cal-health-test-secret";
process.env.RESEND_API_KEY ||= "re_test_key_cal_health";

// ---- Stub outbound calls: token refresh fails, Resend records sends ----
const resendSends = [];
let tokenRefreshResponse = () =>
  new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been revoked." }), { status: 400 });
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.includes("oauth2.googleapis.com/token")) return tokenRefreshResponse();
  if (url.includes("api.resend.com")) {
    resendSends.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: "email_test" }), { status: 200 });
  }
  if (url.includes("connector")) return new Response("unavailable in test", { status: 503 });
  return realFetch(input, init);
};

const orgConnections = await import("../lib/calendar/org-connections.ts");
const { encryptToken } = await import("../lib/calendar/token-crypto.ts");

const RUN = `calhp${Date.now().toString(36)}`;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
let orgId;

before(async () => {
  await db.connect();
  orgId = (await db.query(
    `INSERT INTO organizations (name, slug, settings) VALUES ($1, $2, $3) RETURNING id`,
    [
      `Cal Health ${RUN}`,
      `test-${RUN}`,
      JSON.stringify({ notifications: { calendarConnectionAlerts: true, notificationEmails: ["ops@example.com"] } }),
    ],
  )).rows[0].id;
  // Google OAuth app "configured" so the refresh path actually runs.
  process.env.GOOGLE_OAUTH_CLIENT_ID ||= "test-client-id";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET ||= "test-client-secret";
  // Expired access token + refresh token → every request forces a refresh.
  await db.query(
    `INSERT INTO org_calendar_connections
       (organization_id, provider, account_email, access_token_enc, refresh_token_enc, expires_at)
     VALUES ($1, 'google_calendar', 'client@example.com', $2, $3, now() - interval '1 hour')`,
    [orgId, encryptToken("expired-access"), encryptToken("revoked-refresh")],
  );
});

after(async () => {
  await db.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
  await db.end();
  globalThis.fetch = realFetch;
});

async function attemptRequest() {
  await assert.rejects(
    orgConnections.orgCalendarRequestVia("org", orgId, "google_calendar", "/calendar/v3/calendars/primary/events"),
    /token endpoint failed/,
  );
}

async function connState() {
  const { rows } = await db.query(
    `SELECT status, refresh_failure_count, last_refresh_error FROM org_calendar_connections
     WHERE organization_id = $1 AND provider = 'google_calendar'`,
    [orgId],
  );
  return rows[0];
}

test("repeated refresh failures mark the connection broken and email once", async () => {
  const threshold = orgConnections.REFRESH_ERROR_THRESHOLD;
  for (let i = 1; i < threshold; i++) {
    await attemptRequest();
    const state = await connState();
    assert.equal(state.status, "active", `still active after ${i} failures`);
    assert.equal(state.refresh_failure_count, i);
  }
  await attemptRequest();
  const state = await connState();
  assert.equal(state.status, "error");
  assert.equal(state.refresh_failure_count, threshold);
  assert.match(state.last_refresh_error, /invalid_grant/);

  // Alert delivery is fire-and-forget — give it a beat.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(resendSends.length, 1, "exactly one alert email");
  assert.deepEqual(resendSends[0].to, ["ops@example.com"]);
  assert.match(resendSends[0].subject, /stopped syncing/);
  assert.match(resendSends[0].html, /client@example\.com/);

  // Further failures do NOT re-send the alert.
  await attemptRequest();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(resendSends.length, 1, "no duplicate alert while still broken");
  assert.equal((await connState()).refresh_failure_count, threshold + 1);
});

test("listOrgCalendarConnections exposes the broken status", async () => {
  const list = await orgConnections.listOrgCalendarConnections(orgId);
  const google = list.find((c) => c.provider === "google_calendar");
  assert.equal(google.status, "error");
});

test("reconnecting via OAuth resets the connection to active", async () => {
  tokenRefreshResponse = () =>
    new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }), { status: 200 });
  await orgConnections.completeOrgCalendarConnection({
    organizationId: orgId,
    provider: "google_calendar",
    code: "auth-code",
    redirectUri: "https://example.com/cb",
    connectedBy: null,
  });
  const state = await connState();
  assert.equal(state.status, "active");
  assert.equal(state.refresh_failure_count, 0);
  assert.equal(state.last_refresh_error, null);
});
