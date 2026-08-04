/**
 * End-to-end tests confirming that a booking made through a campaign-minted
 * link credits the campaign correctly:
 *
 *  - Happy path: token carrying a valid campaign id → appointment.campaign_id
 *    is set, campaign stats.appointments increments.
 *  - Wrong-org campaign: cmp in token belongs to a different org → campaign_id NULL.
 *  - Deleted campaign: campaign is removed before the booking → campaign_id NULL.
 *  - Legacy token: no cmp claim → books fine, campaign_id NULL.
 *
 * Runs against the live dev server.
 * Requires DATABASE_URL, ADMIN_PASSWORD and SESSION_SECRET.
 *
 *   node --test tests/campaign-booking-attribution.test.mjs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import pg from "pg";

register("./helpers/server-lib-loader.mjs", import.meta.url);

const BASE = process.env.TEST_BASE_URL ?? "http://127.0.0.1:5000";
const RUN = `cba${Date.now().toString(36)}`;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

const { issueBookingToken } = await import("../lib/booking-token.ts");

async function request(path, { method = "GET", body, cookie } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  const sessionCookie = setCookie.map((c) => c.split(";")[0]).join("; ") || null;
  let json = null;
  try {
    json = await response.json();
  } catch {
    /* non-JSON */
  }
  return { status: response.status, json, cookie: sessionCookie };
}

async function cleanup() {
  await db.query("DELETE FROM organizations WHERE slug LIKE 'test-cba%'");
  await db.query("DELETE FROM users WHERE email LIKE '%@cba-test.local'");
}

async function provisionOrg(adminCookie, suffix = "") {
  const slug = `test-${RUN}${suffix}`;
  const res = await request("/api/admin/organizations", {
    method: "POST",
    cookie: adminCookie,
    body: {
      name: `Test ${RUN}${suffix} CBA`,
      slug,
      plan: "scale",
      modules: ["revenue_rescue", "lead_import", "ai_analysis", "sms_campaigns", "appointments", "analytics"],
      usageLimits: { seats: 5 },
      allowedOrigins: [],
      owner: { email: `owner-${RUN}${suffix}@cba-test.local`, name: "Owner" },
    },
  });
  assert.equal(res.status, 201, `provision org${suffix}: ${JSON.stringify(res.json)}`);
  const orgId = res.json.organizationId;

  const accept = await request("/api/invites/accept", {
    method: "POST",
    body: { token: res.json.inviteToken, name: "Owner", password: "password-own-123" },
  });
  assert.equal(accept.status, 200, `accept invite${suffix}: ${JSON.stringify(accept.json)}`);

  // Disable calendar sync so pushAppointmentToCalendar is a no-op.
  await db.query(
    `UPDATE organizations
     SET settings = coalesce(settings, '{}'::jsonb) || '{"calendar":{"syncProvider":"none"}}'::jsonb
     WHERE id = $1`,
    [orgId],
  );

  return { orgId, ownerCookie: accept.cookie };
}

async function seedLead(orgId, overrides = {}) {
  const row = {
    first_name: "Test",
    last_name: RUN,
    email: null,
    phone: null,
    consent_status: "express",
    suppressed: false,
    score: 70,
    category: "worth_reengaging",
    analysis_status: "analyzed",
    pipeline_stage: "analyzed",
    estimated_value: 8000,
    ...overrides,
  };
  row.email_normalized = row.email ? row.email.toLowerCase() : null;
  row.phone_normalized = row.phone ? row.phone.replace(/[^\d+]/g, "") : null;
  const cols = Object.keys(row);
  const { rows } = await db.query(
    `INSERT INTO rescue_leads (organization_id, ${cols.join(", ")})
     VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")}) RETURNING id`,
    [orgId, ...cols.map((c) => row[c])],
  );
  return rows[0].id;
}

async function createCampaign(orgId, ownerCookie) {
  const res = await request(`/api/orgs/${orgId}/campaigns`, {
    method: "POST",
    cookie: ownerCookie,
    body: {
      name: `CBA Campaign ${RUN}`,
      channel: "sms",
      tone: "professional",
      bookingLink: "{{booking_link}}",
      followUpDelayDays: 7,
      maxAttempts: 3,
      schedule: { quietHoursStart: 0, quietHoursEnd: 0 },
      stopConditions: ["opt_out"],
    },
  });
  assert.equal(res.status, 201, `create campaign: ${JSON.stringify(res.json)}`);
  return res.json.campaign.id;
}

/** A booking body with a scheduledStart safely in the future. */
function bookingBody(overrides = {}) {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  return {
    name: "Booking Tester",
    email: `book-${RUN}@cba-test.local`,
    scheduledStart: tomorrow,
    notes: "E2E test booking",
    ...overrides,
  };
}

/** Returns the campaign_id stored on the most-recent appointment for this org. */
async function lastAppointmentCampaignId(orgId) {
  const { rows } = await db.query(
    `SELECT campaign_id FROM rescue_appointments
     WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [orgId],
  );
  // campaign_id is NULL in DB when not set; use ?? null so a found row with a
  // NULL campaign_id still returns null (not undefined via optional-chaining).
  return rows[0]?.campaign_id ?? null;
}

const state = {};

before(async () => {
  await db.connect();
  await cleanup();

  assert.ok(process.env.ADMIN_PASSWORD, "ADMIN_PASSWORD must be set");
  assert.ok(process.env.SESSION_SECRET, "SESSION_SECRET must be set");

  const adminLogin = await request("/api/admin/session", {
    method: "POST",
    body: { password: process.env.ADMIN_PASSWORD },
  });
  assert.equal(adminLogin.status, 200);
  state.adminCookie = adminLogin.cookie;

  // Primary org used by most tests.
  const { orgId, ownerCookie } = await provisionOrg(state.adminCookie);
  state.org = orgId;
  state.ownerCookie = ownerCookie;

  state.lead = await seedLead(state.org, {
    first_name: "Campaign",
    email: `lead-${RUN}@cba-test.local`,
  });

  state.campaign = await createCampaign(state.org, state.ownerCookie);

  // A second org used for the cross-org safety test.
  const other = await provisionOrg(state.adminCookie, "b");
  state.otherOrg = other.orgId;
  state.otherCampaign = await createCampaign(state.otherOrg, other.ownerCookie);
});

after(async () => {
  await cleanup();
  await db.end();
});

test("booking via campaign-minted token sets campaign_id on the appointment", async () => {
  const token = issueBookingToken({
    organizationId: state.org,
    leadId: state.lead,
    campaignId: state.campaign,
  });

  const res = await request(`/api/book/${token}`, {
    method: "POST",
    body: bookingBody(),
  });
  assert.equal(res.status, 201, `booking should succeed: ${JSON.stringify(res.json)}`);

  const campaignId = await lastAppointmentCampaignId(state.org);
  assert.equal(campaignId, state.campaign, "appointment.campaign_id must match the campaign in the token");
});

test("campaign stats appointments count increments after a campaign booking", async () => {
  // Check the appointment count via the campaigns list API.
  const res = await request(`/api/orgs/${state.org}/campaigns`, { cookie: state.ownerCookie });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const campaign = res.json.campaigns.find((c) => c.id === state.campaign);
  assert.ok(campaign, "campaign must appear in the list");
  assert.ok(
    campaign.stats.appointments >= 1,
    `campaign.stats.appointments must be ≥ 1, got ${campaign.stats.appointments}`,
  );
});

test("token with campaign from a different org stores campaign_id NULL", async () => {
  // Token is valid for state.org but cmp belongs to state.otherOrg.
  const token = issueBookingToken({
    organizationId: state.org,
    leadId: state.lead,
    campaignId: state.otherCampaign,
  });

  const res = await request(`/api/book/${token}`, {
    method: "POST",
    body: bookingBody({ email: `cross-org-${RUN}@cba-test.local` }),
  });
  assert.equal(res.status, 201, `booking should still succeed: ${JSON.stringify(res.json)}`);

  const campaignId = await lastAppointmentCampaignId(state.org);
  assert.equal(campaignId, null, "campaign_id must be NULL when the campaign belongs to a different org");
});

test("token with a deleted campaign stores campaign_id NULL", async () => {
  // Create and immediately delete a campaign, then try to book with its id.
  const ephemeralCampaign = await createCampaign(state.org, state.ownerCookie);
  await db.query(
    `DELETE FROM rescue_campaigns WHERE organization_id = $1 AND id = $2`,
    [state.org, ephemeralCampaign],
  );

  const token = issueBookingToken({
    organizationId: state.org,
    leadId: state.lead,
    campaignId: ephemeralCampaign,
  });

  const res = await request(`/api/book/${token}`, {
    method: "POST",
    body: bookingBody({ email: `deleted-cmp-${RUN}@cba-test.local` }),
  });
  assert.equal(res.status, 201, `booking should succeed even with a deleted campaign: ${JSON.stringify(res.json)}`);

  const campaignId = await lastAppointmentCampaignId(state.org);
  assert.equal(campaignId, null, "campaign_id must be NULL when the campaign no longer exists");
});

test("legacy token without cmp claim books fine with campaign_id NULL", async () => {
  // Mint a token without a campaign id (simulates pre-attribution tokens).
  const token = issueBookingToken({
    organizationId: state.org,
    leadId: state.lead,
    // campaignId intentionally omitted
  });

  const res = await request(`/api/book/${token}`, {
    method: "POST",
    body: bookingBody({ email: `legacy-${RUN}@cba-test.local` }),
  });
  assert.equal(res.status, 201, `legacy token booking should succeed: ${JSON.stringify(res.json)}`);

  const campaignId = await lastAppointmentCampaignId(state.org);
  assert.equal(campaignId, null, "campaign_id must be NULL for legacy tokens without a cmp claim");
});
