/**
 * Scheduled downgrade tests: self-serve downgrades are deferred to the next
 * usage-period start; upgrades still apply immediately. Runs against the live
 * dev server. Requires DATABASE_URL and ADMIN_PASSWORD in the env.
 *
 *   node --test tests/plan-downgrade.test.mjs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const BASE = process.env.TEST_BASE_URL ?? "http://127.0.0.1:5000";
const RUN = `pd${Date.now().toString(36)}`;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

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
  if ((response.headers.get("content-type") ?? "").includes("application/json")) {
    json = await response.json().catch(() => null);
  }
  return { status: response.status, json, cookie: sessionCookie };
}

const state = {};

async function subRow() {
  const { rows } = await db.query(
    "SELECT plan_id, status, pending_plan_id, pending_plan_effective_at FROM org_subscriptions WHERE organization_id = $1",
    [state.org],
  );
  return rows[0];
}

async function cleanup() {
  await db.query("DELETE FROM organizations WHERE slug LIKE 'test-pd%'");
  await db.query("DELETE FROM users WHERE email LIKE '%@plan-downgrade-test.local'");
}

before(async () => {
  await db.connect();
  await cleanup();

  assert.ok(process.env.ADMIN_PASSWORD, "ADMIN_PASSWORD must be set for tests");
  const adminLogin = await request("/api/admin/session", { method: "POST", body: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(adminLogin.status, 200);
  state.adminCookie = adminLogin.cookie;

  const provision = await request("/api/admin/organizations", {
    method: "POST",
    cookie: state.adminCookie,
    body: {
      name: `Test ${RUN} Downgrade`,
      slug: `test-${RUN}`,
      plan: "growth",
      modules: ["revenue_rescue"],
      owner: { email: `owner-${RUN}@plan-downgrade-test.local`, name: "Owner" },
    },
  });
  assert.equal(provision.status, 201, JSON.stringify(provision.json));
  state.org = provision.json.organizationId;

  const accept = await request("/api/invites/accept", {
    method: "POST",
    body: { token: provision.json.inviteToken, name: "Owner", password: "password-pd-123" },
  });
  assert.equal(accept.status, 200);
  state.owner = accept.cookie;

  // Put the org on an active paid plan (pro) so the next change can be a downgrade.
  await db.query(
    `INSERT INTO org_subscriptions (organization_id, plan_id, status)
     VALUES ($1, 'pro', 'active')
     ON CONFLICT (organization_id) DO UPDATE SET plan_id = 'pro', status = 'active', trial_ends_at = NULL`,
    [state.org],
  );
});

after(async () => {
  await cleanup();
  await db.end();
});

test("downgrade is scheduled for the next period start, not applied immediately", async () => {
  const res = await request(`/api/orgs/${state.org}/plan`, { method: "POST", cookie: state.owner, body: { planId: "core" } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.scheduled, true);
  assert.equal(res.json.planId, "core");
  assert.ok(res.json.effectiveAt, "effectiveAt returned");
  // Effective date is the first instant of the next UTC month.
  const eff = new Date(res.json.effectiveAt);
  assert.equal(eff.getUTCDate(), 1);
  assert.ok(eff.getTime() > Date.now());

  const row = await subRow();
  assert.equal(row.plan_id, "pro", "still on the paid plan");
  assert.equal(row.pending_plan_id, "core");

  const audit = await db.query(
    "SELECT 1 FROM audit_logs WHERE organization_id = $1 AND action = 'subscription.downgrade_scheduled'",
    [state.org],
  );
  assert.equal(audit.rowCount, 1);
});

test("scheduling again overwrites the pending target", async () => {
  // pro → core already pending; core is the only cheaper plan, so re-post the same target.
  const res = await request(`/api/orgs/${state.org}/plan`, { method: "POST", cookie: state.owner, body: { planId: "core" } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.scheduled, true);
  const row = await subRow();
  assert.equal(row.pending_plan_id, "core");
});

test("the pending downgrade can be cancelled", async () => {
  const res = await request(`/api/orgs/${state.org}/plan`, { method: "DELETE", cookie: state.owner });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const row = await subRow();
  assert.equal(row.plan_id, "pro");
  assert.equal(row.pending_plan_id, null);

  const audit = await db.query(
    "SELECT 1 FROM audit_logs WHERE organization_id = $1 AND action = 'subscription.downgrade_cancelled'",
    [state.org],
  );
  assert.equal(audit.rowCount, 1);

  const again = await request(`/api/orgs/${state.org}/plan`, { method: "DELETE", cookie: state.owner });
  assert.equal(again.status, 404, "nothing left to cancel");
});

test("upgrades still apply immediately and clear any pending downgrade", async () => {
  // Re-schedule a downgrade, then upgrade past it.
  const down = await request(`/api/orgs/${state.org}/plan`, { method: "POST", cookie: state.owner, body: { planId: "core" } });
  assert.equal(down.status, 200);
  assert.equal(down.json.scheduled, true);

  const up = await request(`/api/orgs/${state.org}/plan`, { method: "POST", cookie: state.owner, body: { planId: "complete" } });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.notEqual(up.json.scheduled, true);

  const row = await subRow();
  assert.equal(row.plan_id, "complete", "upgrade applied immediately");
  assert.equal(row.pending_plan_id, null, "pending downgrade cleared");
});

test("a due pending change is applied by the cron pass and audit-logged", async () => {
  // Schedule complete → core, then backdate the effective date and run the cron route.
  const down = await request(`/api/orgs/${state.org}/plan`, { method: "POST", cookie: state.owner, body: { planId: "core" } });
  assert.equal(down.status, 200);
  assert.equal(down.json.scheduled, true);
  await db.query("UPDATE org_subscriptions SET pending_plan_effective_at = now() - interval '1 hour' WHERE organization_id = $1", [state.org]);

  const cron = await request("/api/cron/plan-changes", { method: "POST", cookie: state.adminCookie });
  assert.equal(cron.status, 200, JSON.stringify(cron.json));
  assert.ok(cron.json.applied >= 1, JSON.stringify(cron.json));

  const row = await subRow();
  assert.equal(row.plan_id, "core");
  assert.equal(row.pending_plan_id, null);

  const audit = await db.query(
    "SELECT metadata FROM audit_logs WHERE organization_id = $1 AND action = 'subscription.scheduled_change_applied'",
    [state.org],
  );
  assert.equal(audit.rowCount, 1);
});

test("trial conversion applies immediately even to a cheaper plan", async () => {
  await db.query(
    "UPDATE org_subscriptions SET plan_id = 'complete', status = 'trialing', trial_ends_at = now() + interval '7 days' WHERE organization_id = $1",
    [state.org],
  );
  // core is cheaper than complete, but a trial pick converts immediately.
  const res = await request(`/api/orgs/${state.org}/plan`, { method: "POST", cookie: state.owner, body: { planId: "pro" } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.notEqual(res.json.scheduled, true);
  const row = await subRow();
  assert.equal(row.plan_id, "pro");
  assert.equal(row.status, "active");
});
