/**
 * Integration tests for the discovery opportunity engine end to end, over live
 * HTTP against the dev server and the real database:
 *
 * - POST /api/cron/discovery (CRON_SECRET) triggers signal adapters and surfaces
 *   stale-estimate and hot-uncontacted opportunities for a qualifying org
 * - GET /api/orgs/:orgId/opportunities returns only "new" cards by default;
 *   dismissed cards appear when includeDismissed=true
 * - PATCH /api/orgs/:orgId/opportunities/:id updates status correctly
 *
 * Requires: dev server on port 5000, DATABASE_URL, ADMIN_PASSWORD, CRON_SECRET.
 *
 *   node --test tests/discovery-opportunities.test.mjs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const BASE = process.env.TEST_BASE_URL ?? "http://127.0.0.1:5000";
const RUN = `disc${Date.now().toString(36)}`;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

async function request(path, { method = "GET", body, cookie, headers = {} } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  const sessionCookie = setCookie.map((c) => c.split(";")[0]).join("; ") || null;
  const json = (response.headers.get("content-type") ?? "").includes("application/json")
    ? await response.json().catch(() => null)
    : null;
  return { status: response.status, json, cookie: sessionCookie };
}

const state = {};

async function cleanup() {
  await db.query("DELETE FROM organizations WHERE slug LIKE 'test-disc%'");
  await db.query("DELETE FROM users WHERE email LIKE '%@disc-test.local'");
}

/** Insert a rescue_lead directly and return its id. */
async function insertLead(fields) {
  const { rows } = await db.query(
    `INSERT INTO rescue_leads
       (organization_id, first_name, last_name, pipeline_stage, estimate_date,
        estimated_value, score, category, suppressed)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      state.orgId,
      fields.firstName ?? "Test",
      fields.lastName ?? "Lead",
      fields.pipelineStage ?? "imported",
      fields.estimateDate ?? null,
      fields.estimatedValue ?? null,
      fields.score ?? null,
      fields.category ?? null,
      fields.suppressed ?? false,
    ],
  );
  return String(rows[0].id);
}

/** Trigger the discovery cron with CRON_SECRET bearer auth. */
async function triggerDiscoveryCron() {
  const secret = process.env.CRON_SECRET;
  assert.ok(secret, "CRON_SECRET must be set for discovery tests");
  return request("/api/cron/discovery", {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
  });
}

before(async () => {
  await db.connect();
  await cleanup();

  assert.ok(process.env.ADMIN_PASSWORD, "ADMIN_PASSWORD must be set for tests");
  assert.ok(process.env.CRON_SECRET, "CRON_SECRET must be set for tests");

  const adminLogin = await request("/api/admin/session", {
    method: "POST",
    body: { password: process.env.ADMIN_PASSWORD },
  });
  assert.equal(adminLogin.status, 200, "Admin login failed");

  // Provision an org with revenue_rescue entitlement (included in "growth" plan).
  const provision = await request("/api/admin/organizations", {
    method: "POST",
    cookie: adminLogin.cookie,
    body: {
      name: `Test ${RUN} Discovery`,
      slug: `test-${RUN}`,
      plan: "growth",
      modules: ["revenue_rescue"],
      usageLimits: { seats: 5 },
      allowedOrigins: [],
      owner: { email: `owner-${RUN}@disc-test.local`, name: "Owner" },
    },
  });
  assert.equal(provision.status, 201, JSON.stringify(provision.json));
  state.orgId = provision.json.organizationId;

  // Activate the owner so we can use session auth on the opportunities API.
  const accept = await request("/api/invites/accept", {
    method: "POST",
    body: { token: provision.json.inviteToken, name: "Owner", password: "password-disc-123" },
  });
  assert.equal(accept.status, 200, "Invite accept failed");
  state.owner = accept.cookie;

  // Insert a stale-estimate lead: estimate issued > 60 days ago, not suppressed.
  state.staleLeadId = await insertLead({
    firstName: "Stale",
    lastName: "Customer",
    pipelineStage: "estimate_issued",
    estimateDate: new Date(Date.now() - 65 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    estimatedValue: 5000,
    suppressed: false,
  });

  // Insert a hot-uncontacted lead: high score, early stage, no outbound messages.
  state.hotLeadId = await insertLead({
    firstName: "Hot",
    lastName: "Prospect",
    pipelineStage: "imported",
    score: 9,
    category: "hot",
    suppressed: false,
  });
});

after(async () => {
  await cleanup();
  await db.end();
});

// ---------------------------------------------------------------------------

test("cron: POST /api/cron/discovery requires auth", async () => {
  const res = await request("/api/cron/discovery", { method: "POST" });
  assert.equal(res.status, 401);
});

test("cron: POST /api/cron/discovery with CRON_SECRET runs and adds opportunities", async () => {
  const res = await triggerDiscoveryCron();
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.ok(typeof res.json.organizations === "number", "response must include organizations count");
  assert.ok(typeof res.json.opportunitiesAdded === "number", "response must include opportunitiesAdded");
  // Our org has at least the stale estimate and hot uncontacted leads → ≥ 2 added.
  assert.ok(res.json.opportunitiesAdded >= 2, `Expected ≥2 opportunities added, got ${res.json.opportunitiesAdded}`);
  state.cronRan = true;
});

test("opportunities list: stale_estimate card is visible after cron run", async () => {
  assert.ok(state.cronRan, "cron must have run first");
  const res = await request(`/api/orgs/${state.orgId}/opportunities`, { cookie: state.owner });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const opps = res.json.opportunities;
  assert.ok(Array.isArray(opps), "opportunities must be an array");

  const stale = opps.find((o) => o.kind === "stale_estimate" && o.leadId === state.staleLeadId);
  assert.ok(stale, `Expected a stale_estimate opportunity for lead ${state.staleLeadId}`);
  assert.equal(stale.status, "new");
  assert.ok(stale.title, "opportunity must have a title");
  assert.ok(stale.actionHint, "opportunity must have an actionHint");

  // Save for later status-update tests.
  state.staleOppId = stale.id;
});

test("opportunities list: hot_uncontacted card is visible after cron run", async () => {
  assert.ok(state.cronRan, "cron must have run first");
  const res = await request(`/api/orgs/${state.orgId}/opportunities`, { cookie: state.owner });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const opps = res.json.opportunities;

  const hot = opps.find((o) => o.kind === "hot_uncontacted" && o.leadId === state.hotLeadId);
  assert.ok(hot, `Expected a hot_uncontacted opportunity for lead ${state.hotLeadId}`);
  assert.equal(hot.status, "new");
  state.hotOppId = hot.id;
});

test("opportunities list: requires member auth", async () => {
  const res = await request(`/api/orgs/${state.orgId}/opportunities`);
  assert.equal(res.status, 401);
});

test("opportunities list: dismissed card is excluded by default, included with includeDismissed=true", async () => {
  assert.ok(state.staleOppId, "staleOppId must be set");

  // Dismiss the stale opportunity via PATCH.
  const patch = await request(`/api/orgs/${state.orgId}/opportunities/${state.staleOppId}`, {
    method: "PATCH",
    cookie: state.owner,
    body: { status: "dismissed" },
  });
  assert.equal(patch.status, 200, JSON.stringify(patch.json));
  assert.equal(patch.json.ok, true);

  // Default list must not include it.
  const defaultList = await request(`/api/orgs/${state.orgId}/opportunities`, { cookie: state.owner });
  assert.equal(defaultList.status, 200);
  const inDefault = defaultList.json.opportunities.some((o) => o.id === state.staleOppId);
  assert.equal(inDefault, false, "dismissed card must not appear in default list");

  // With includeDismissed=true it must appear.
  const withDismissed = await request(
    `/api/orgs/${state.orgId}/opportunities?includeDismissed=true`,
    { cookie: state.owner },
  );
  assert.equal(withDismissed.status, 200);
  const dismissed = withDismissed.json.opportunities.find((o) => o.id === state.staleOppId);
  assert.ok(dismissed, "dismissed card must appear when includeDismissed=true");
  assert.equal(dismissed.status, "dismissed");
});

test("PATCH opportunity: updates status to actioned", async () => {
  assert.ok(state.hotOppId, "hotOppId must be set");

  const res = await request(`/api/orgs/${state.orgId}/opportunities/${state.hotOppId}`, {
    method: "PATCH",
    cookie: state.owner,
    body: { status: "actioned" },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.ok, true);

  // Verify it no longer shows in the default (new-only) list.
  const list = await request(`/api/orgs/${state.orgId}/opportunities`, { cookie: state.owner });
  const inDefault = list.json.opportunities.some((o) => o.id === state.hotOppId);
  assert.equal(inDefault, false, "actioned card must not appear in default list");

  // Verify it appears with includeActioned=true.
  const withActioned = await request(
    `/api/orgs/${state.orgId}/opportunities?includeActioned=true`,
    { cookie: state.owner },
  );
  const actioned = withActioned.json.opportunities.find((o) => o.id === state.hotOppId);
  assert.ok(actioned, "actioned card must appear when includeActioned=true");
  assert.equal(actioned.status, "actioned");
});

test("PATCH opportunity: rejects invalid status values", async () => {
  assert.ok(state.staleOppId, "staleOppId must be set");
  const res = await request(`/api/orgs/${state.orgId}/opportunities/${state.staleOppId}`, {
    method: "PATCH",
    cookie: state.owner,
    body: { status: "new" },
  });
  assert.equal(res.status, 400);
});

test("PATCH opportunity: rejected for opportunity belonging to a different org", async () => {
  assert.ok(state.staleOppId, "staleOppId must be set");
  // Use a random but valid-format UUID as a fake org — the server rejects non-members.
  const res = await request(
    `/api/orgs/00000000-0000-0000-0000-000000000000/opportunities/${state.staleOppId}`,
    { method: "PATCH", cookie: state.owner, body: { status: "actioned" } },
  );
  // 401 (unauthenticated), 403 (not a member), or 404 (not found) — all acceptable.
  assert.ok([401, 403, 404].includes(res.status), `Expected 401/403/404, got ${res.status}`);
});

test("cron: re-running discovery does not create duplicate 'new' opportunities for the same lead+kind", async () => {
  // Insert a fresh qualifying lead that has never been touched by the earlier tests.
  const freshLeadId = await insertLead({
    firstName: "Fresh",
    lastName: "Dedup",
    pipelineStage: "estimate_issued",
    estimateDate: new Date(Date.now() - 70 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    estimatedValue: 3000,
    suppressed: false,
  });

  // First run — creates the 'new' opportunity.
  await triggerDiscoveryCron();
  // Second run — must not insert a second 'new' row for the same (org, kind, dedup_key).
  await triggerDiscoveryCron();

  // The partial unique index guarantees at most one 'new' row per (org, kind, dedup_key).
  // Verify directly in the DB.
  const { rows } = await db.query(
    `SELECT kind, dedup_key, COUNT(*) AS cnt
     FROM org_opportunities
     WHERE organization_id = $1 AND status = 'new'
     GROUP BY kind, dedup_key
     HAVING COUNT(*) > 1`,
    [state.orgId],
  );
  assert.equal(rows.length, 0, `Duplicate 'new' opportunities found: ${JSON.stringify(rows)}`);

  // Also verify that at least one 'new' opportunity exists for the fresh lead.
  const { rows: freshRows } = await db.query(
    `SELECT id FROM org_opportunities
     WHERE organization_id = $1 AND lead_id = $2 AND status = 'new'`,
    [state.orgId, freshLeadId],
  );
  assert.ok(freshRows.length >= 1, "fresh lead must produce at least one new opportunity");
  assert.ok(freshRows.length <= 1, "fresh lead must not produce duplicate new opportunities");
});
