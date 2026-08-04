/**
 * Scheduled downgrade reminder tests: the plan-changes cron pass claims
 * pending changes inside the 3-day window and sends (or preference-skips)
 * one reminder per scheduled change. Runs against the live dev server.
 * Requires DATABASE_URL and ADMIN_PASSWORD in the env.
 *
 * Sends are exercised through the preference-skip paths (toggle off /
 * no recipients) so tests never fire real Resend emails.
 *
 *   node --test tests/plan-change-reminder.test.mjs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const BASE = process.env.TEST_BASE_URL ?? "http://127.0.0.1:5000";
const RUN = `pr${Date.now().toString(36)}`;
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

async function subRow(org) {
  const { rows } = await db.query(
    "SELECT plan_id, pending_plan_id, pending_plan_effective_at, pending_plan_reminder_sent_at FROM org_subscriptions WHERE organization_id = $1",
    [org],
  );
  return rows[0];
}

async function provisionOrg(suffix) {
  const provision = await request("/api/admin/organizations", {
    method: "POST",
    cookie: state.adminCookie,
    body: {
      name: `Test ${RUN} Reminder ${suffix}`,
      slug: `test-${RUN}-${suffix}`,
      plan: "growth",
      modules: ["revenue_rescue"],
      owner: { email: `owner-${RUN}-${suffix}@plan-reminder-test.local`, name: "Owner" },
    },
  });
  assert.equal(provision.status, 201, JSON.stringify(provision.json));
  const org = provision.json.organizationId;
  await db.query(
    `INSERT INTO org_subscriptions (organization_id, plan_id, status)
     VALUES ($1, 'pro', 'active')
     ON CONFLICT (organization_id) DO UPDATE SET plan_id = 'pro', status = 'active', trial_ends_at = NULL`,
    [org],
  );
  return org;
}

function schedulePending(org, effectiveAt) {
  return db.query(
    `UPDATE org_subscriptions
     SET pending_plan_id = 'core', pending_plan_effective_at = $2, pending_plan_reminder_sent_at = NULL
     WHERE organization_id = $1`,
    [org, effectiveAt],
  );
}

async function cleanup() {
  await db.query("DELETE FROM organizations WHERE slug LIKE 'test-pr%'");
  await db.query("DELETE FROM users WHERE email LIKE '%@plan-reminder-test.local'");
}

before(async () => {
  await db.connect();
  await cleanup();
  assert.ok(process.env.ADMIN_PASSWORD, "ADMIN_PASSWORD must be set for tests");
  const adminLogin = await request("/api/admin/session", { method: "POST", body: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(adminLogin.status, 200);
  state.adminCookie = adminLogin.cookie;
});

after(async () => {
  await cleanup();
  await db.end();
});

test("pending change inside the window is claimed once; toggle-off skip does not retry", async () => {
  const org = await provisionOrg("a");
  // Toggle off so no real email is attempted; recipients present.
  await db.query(
    `UPDATE organizations SET settings = jsonb_set(
       COALESCE(settings, '{}'::jsonb), '{notifications}',
       '{"planChangeReminders": false, "notificationEmails": ["ops@plan-reminder-test.local"]}'::jsonb, true)
     WHERE id = $1`,
    [org],
  );
  const twoDays = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  await schedulePending(org, twoDays);

  const cron = await request("/api/cron/plan-changes", { method: "POST", cookie: state.adminCookie });
  assert.equal(cron.status, 200, JSON.stringify(cron.json));
  const outcome = cron.json.reminders.find((r) => r.organizationId === org);
  assert.ok(outcome, "reminder pass considered the org");
  assert.equal(outcome.status, "skipped");
  assert.equal(outcome.reason, "toggle_off");

  const row = await subRow(org);
  assert.ok(row.pending_plan_reminder_sent_at, "claim recorded so pass never re-nags");
  assert.equal(row.pending_plan_id, "core", "pending change untouched");

  // Second pass ignores the already-claimed row.
  const again = await request("/api/cron/plan-changes", { method: "POST", cookie: state.adminCookie });
  assert.equal(again.status, 200);
  assert.equal(again.json.reminders.some((r) => r.organizationId === org), false);
});

test("pending change outside the 3-day window is not claimed", async () => {
  const org = await provisionOrg("b");
  const tenDays = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
  await schedulePending(org, tenDays);

  const cron = await request("/api/cron/plan-changes", { method: "POST", cookie: state.adminCookie });
  assert.equal(cron.status, 200);
  assert.equal(cron.json.reminders.some((r) => r.organizationId === org), false);
  const row = await subRow(org);
  assert.equal(row.pending_plan_reminder_sent_at, null);
});

test("re-scheduling clears the reminder claim so the new change gets its own reminder", async () => {
  const org = await provisionOrg("c");
  const twoDays = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  await schedulePending(org, twoDays);
  await db.query(
    `UPDATE organizations SET settings = jsonb_set(
       COALESCE(settings, '{}'::jsonb), '{notifications}',
       '{"planChangeReminders": false, "notificationEmails": ["ops@plan-reminder-test.local"]}'::jsonb, true)
     WHERE id = $1`,
    [org],
  );
  await request("/api/cron/plan-changes", { method: "POST", cookie: state.adminCookie });
  assert.ok((await subRow(org)).pending_plan_reminder_sent_at, "first claim recorded");

  // Re-schedule the way schedulePendingPlanChange does (UPDATE with reminder reset).
  const { rows } = await db.query(
    `UPDATE org_subscriptions
     SET pending_plan_id = 'core', pending_plan_effective_at = $2, pending_plan_reminder_sent_at = NULL
     WHERE organization_id = $1 RETURNING pending_plan_reminder_sent_at`,
    [org, twoDays],
  );
  assert.equal(rows[0].pending_plan_reminder_sent_at, null);

  // no-recipients path consumes the claim with reason no_recipients
  await db.query(
    `UPDATE organizations SET settings = jsonb_set(
       COALESCE(settings, '{}'::jsonb), '{notifications}',
       '{"planChangeReminders": true, "notificationEmails": []}'::jsonb, true)
     WHERE id = $1`,
    [org],
  );
  const cron = await request("/api/cron/plan-changes", { method: "POST", cookie: state.adminCookie });
  const outcome = cron.json.reminders.find((r) => r.organizationId === org);
  assert.equal(outcome?.status, "skipped");
  assert.equal(outcome?.reason, "no_recipients");
  assert.ok((await subRow(org)).pending_plan_reminder_sent_at);
});
