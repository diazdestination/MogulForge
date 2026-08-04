/**
 * End-to-end coverage for campaign sends with a booking link configured.
 *
 * A simulation campaign whose booking-link field is the {{booking_link}}
 * placeholder must write rescue_messages whose bodies contain a valid,
 * verifiable per-lead /book/<token> URL — and never a raw placeholder — across
 * every send pass:
 *  - first-touch simulated sends at activation (runSimulatedSends via the
 *    activate route);
 *  - the pre-activation preview route's sample messages;
 *  - follow-up sends (runFollowUpPass, invoked in-process against the same DB).
 *
 * Also covers the fallback order when minting is impossible: with no public
 *   base URL, or no SESSION_SECRET, the org's Calendly URL is used instead and
 *   the placeholder is still never leaked.
 *
 * Runs against the live dev server. Requires DATABASE_URL, ADMIN_PASSWORD and
 * SESSION_SECRET (the same secret the dev server signs booking tokens with).
 * Run alone: node --test tests/booking-link-sends.test.mjs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import pg from "pg";

register("./helpers/server-lib-loader.mjs", import.meta.url);

const BASE = process.env.TEST_BASE_URL ?? "http://127.0.0.1:5000";
const RUN = `bls${Date.now().toString(36)}`;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

const { verifyBookingToken } = await import("../lib/booking-token.ts");

// Follow-up passes run in-process; keep them deterministic (template drafts,
// no AI) regardless of the workspace's OpenAI key.
delete process.env.OPENAI_API_KEY;

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
  await db.query("DELETE FROM organizations WHERE slug LIKE 'test-bls%'");
  await db.query("DELETE FROM users WHERE email LIKE '%@bls-test.local'");
}

async function seedLead(orgId, fields = {}) {
  const defaults = {
    first_name: "Lead",
    last_name: RUN,
    email: null,
    phone: null,
    consent_status: "express",
    suppressed: false,
    score: 70,
    category: "worth_reengaging",
    analysis_status: "analyzed",
    pipeline_stage: "analyzed",
    estimated_value: 9000,
  };
  const row = { ...defaults, ...fields };
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

const CALENDLY_URL = `https://calendly.com/acme-${RUN}/intro`;
const state = { seenMessageIds: new Set() };

/** Campaign messages not seen by a previous assertion, oldest first. */
async function newMessages() {
  const { rows } = await db.query(
    `SELECT id, lead_id, body, subject, simulated, status FROM rescue_messages
     WHERE organization_id = $1 AND campaign_id = $2 ORDER BY created_at ASC`,
    [state.org, state.campaign],
  );
  const fresh = rows.filter((r) => !state.seenMessageIds.has(r.id));
  for (const r of fresh) state.seenMessageIds.add(r.id);
  return fresh;
}

/** Extracts the /book/<token> token from a message body, or null. */
function bookingTokenIn(text) {
  const match = /\/book\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(text);
  return match ? match[1] : null;
}

function assertNoPlaceholder(text) {
  assert.ok(!/\{\{/.test(text), `raw placeholder leaked into message: ${text}`);
}

async function backdateCampaignLeads() {
  await db.query(
    `UPDATE rescue_campaign_leads SET last_message_at = now() - interval '10 days'
     WHERE organization_id = $1 AND campaign_id = $2`,
    [state.org, state.campaign],
  );
}

before(async () => {
  await db.connect();
  await cleanup();

  assert.ok(process.env.ADMIN_PASSWORD, "ADMIN_PASSWORD must be set for tests");
  assert.ok(process.env.SESSION_SECRET, "SESSION_SECRET must be set for tests");
  const adminLogin = await request("/api/admin/session", { method: "POST", body: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(adminLogin.status, 200);

  const provision = await request("/api/admin/organizations", {
    method: "POST",
    cookie: adminLogin.cookie,
    body: {
      name: `Test ${RUN} BookingLinks`,
      slug: `test-${RUN}`,
      plan: "scale",
      modules: ["revenue_rescue", "lead_import", "ai_analysis", "sms_campaigns", "email_campaigns", "appointments", "analytics"],
      usageLimits: { seats: 10 },
      allowedOrigins: [],
      owner: { email: `owner-${RUN}@bls-test.local`, name: "Owner" },
    },
  });
  assert.equal(provision.status, 201, JSON.stringify(provision.json));
  state.org = provision.json.organizationId;

  const acceptOwner = await request("/api/invites/accept", {
    method: "POST",
    body: { token: provision.json.inviteToken, name: "Owner", password: "password-own-123" },
  });
  assert.equal(acceptOwner.status, 200);
  state.ownerCookie = acceptOwner.cookie;

  // Org-level Calendly URL — the fallback when /book minting is unavailable.
  await db.query(
    `UPDATE organizations
     SET settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('calendar', jsonb_build_object('syncProvider', 'none', 'calendlyUrl', $2::text))
     WHERE id = $1`,
    [state.org, CALENDLY_URL],
  );

  state.leadA = await seedLead(state.org, { first_name: "Alice", phone: "+15551440001", email: `alice-${RUN}@bls-test.local` });
  state.leadB = await seedLead(state.org, { first_name: "Bruno", phone: "+15551440002" });
});

after(async () => {
  await cleanup();
  await db.end();
});

test("preview samples resolve the placeholder to per-lead /book URLs", async () => {
  const create = await request(`/api/orgs/${state.org}/campaigns`, {
    method: "POST",
    cookie: state.ownerCookie,
    body: {
      name: `Booking ${RUN}`,
      channel: "sms",
      tone: "professional",
      bookingLink: "{{booking_link}}",
      followUpDelayDays: 1,
      maxAttempts: 6,
      // Degenerate quiet window so follow-up passes are never time-gated.
      schedule: { quietHoursStart: 0, quietHoursEnd: 0 },
      stopConditions: ["opt_out"],
    },
  });
  assert.equal(create.status, 201, JSON.stringify(create.json));
  state.campaign = create.json.campaign.id;
  assert.equal(create.json.campaign.bookingLink, "{{booking_link}}");

  const preview = await request(`/api/orgs/${state.org}/campaigns/${state.campaign}/preview`, { cookie: state.ownerCookie });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.equal(preview.json.accounting.eligible, 2);
  assert.ok(preview.json.samples.length >= 1, "preview must include sample messages");
  for (const sample of preview.json.samples) {
    assertNoPlaceholder(sample.body);
    const token = bookingTokenIn(sample.body);
    assert.ok(token, `preview sample must contain a /book/<token> URL: ${sample.body}`);
    const check = verifyBookingToken(token);
    assert.ok(check.ok, `preview token must verify: ${JSON.stringify(check)}`);
    assert.equal(check.claims.org, state.org);
  }
});

test("simulation activation writes messages with valid per-lead booking tokens", async () => {
  const res = await request(`/api/orgs/${state.org}/campaigns/${state.campaign}/activate`, {
    method: "POST",
    cookie: state.ownerCookie,
    body: { mode: "simulation", confirm: true },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.enrolled, 2);
  assert.equal(res.json.simulatedSends, 2);

  const messages = await newMessages();
  assert.equal(messages.length, 2);
  const leads = new Set([state.leadA, state.leadB]);
  for (const message of messages) {
    assert.equal(message.simulated, true);
    assertNoPlaceholder(message.body);
    const token = bookingTokenIn(message.body);
    assert.ok(token, `stored body must contain a /book/<token> URL: ${message.body}`);
    const check = verifyBookingToken(token);
    assert.ok(check.ok, `stored token must verify: ${JSON.stringify(check)}`);
    assert.equal(check.claims.org, state.org, "token must be scoped to this org");
    assert.equal(check.claims.lead, message.lead_id, "token must be minted for the message's own lead");
    leads.delete(message.lead_id);
  }
  assert.equal(leads.size, 0, "every enrolled lead got a first-touch message");
});

test("follow-up pass also writes valid per-lead booking tokens", async () => {
  const { runFollowUpPass } = await import("../lib/rescue-engage/follow-up-scheduler.ts");
  await backdateCampaignLeads();
  await runFollowUpPass(new Date());

  const messages = await newMessages().then((rows) => rows.filter((r) => [state.leadA, state.leadB].includes(r.lead_id)));
  assert.equal(messages.length, 2, "both leads were due a follow-up");
  for (const message of messages) {
    assertNoPlaceholder(message.body);
    const token = bookingTokenIn(message.body);
    assert.ok(token, `follow-up body must contain a /book/<token> URL: ${message.body}`);
    const check = verifyBookingToken(token);
    assert.ok(check.ok);
    assert.equal(check.claims.org, state.org);
    assert.equal(check.claims.lead, message.lead_id);
  }
});

test("without a public base URL, sends fall back to the Calendly URL — never the raw placeholder", async () => {
  const { runFollowUpPass } = await import("../lib/rescue-engage/follow-up-scheduler.ts");
  const savedBase = process.env.PUBLIC_BASE_URL;
  const savedDomains = process.env.REPLIT_DOMAINS;
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.REPLIT_DOMAINS;
  try {
    await backdateCampaignLeads();
    await runFollowUpPass(new Date());
  } finally {
    if (savedBase !== undefined) process.env.PUBLIC_BASE_URL = savedBase;
    if (savedDomains !== undefined) process.env.REPLIT_DOMAINS = savedDomains;
  }

  const messages = await newMessages().then((rows) => rows.filter((r) => [state.leadA, state.leadB].includes(r.lead_id)));
  assert.equal(messages.length, 2);
  for (const message of messages) {
    assertNoPlaceholder(message.body);
    assert.equal(bookingTokenIn(message.body), null, "no base URL means no minted /book link");
    assert.ok(message.body.includes(CALENDLY_URL), `body must fall back to the Calendly URL: ${message.body}`);
  }
});

test("without SESSION_SECRET, minting fails closed to the Calendly URL", async () => {
  const { runFollowUpPass } = await import("../lib/rescue-engage/follow-up-scheduler.ts");
  const savedSecret = process.env.SESSION_SECRET;
  delete process.env.SESSION_SECRET;
  try {
    await backdateCampaignLeads();
    await runFollowUpPass(new Date());
  } finally {
    process.env.SESSION_SECRET = savedSecret;
  }

  const messages = await newMessages().then((rows) => rows.filter((r) => [state.leadA, state.leadB].includes(r.lead_id)));
  assert.equal(messages.length, 2);
  for (const message of messages) {
    assertNoPlaceholder(message.body);
    assert.equal(bookingTokenIn(message.body), null, "unsigned /book links must never be emitted");
    assert.ok(message.body.includes(CALENDLY_URL), `body must fall back to the Calendly URL: ${message.body}`);
  }
});
