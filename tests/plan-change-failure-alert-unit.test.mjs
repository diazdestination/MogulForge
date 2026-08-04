/**
 * Repeated plan-change failure escalation tests: consecutive failed apply
 * passes are counted, admins are alerted exactly once at the threshold, the
 * claim releases on delivery failure, and the counter resets on success or
 * rescheduling.
 *
 * Imports the server lib directly (loader stubs "server-only"). Requires
 * DATABASE_URL. Run alone (never in a parallel `npm test` against next dev):
 *   node --test tests/plan-change-failure-alert-unit.test.mjs
 */
import { register } from "node:module";
register("./helpers/server-lib-loader.mjs", import.meta.url);

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const { registerBillingAdapter } = await import("../lib/billing.ts");
const { applyDuePendingPlanChanges, schedulePendingPlanChange, listFailingPlanChanges } = await import("../lib/subscriptions.ts");
const { setPlanChangeAlertSenderForTests, PLAN_CHANGE_FAILURE_ALERT_THRESHOLD } = await import("../lib/plan-change-alerts.ts");

const RUN = `pcfa${Date.now().toString(36)}`;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

// ---- Fake provider: programmable outcome. ----
let nextOutcome = { ok: false, providerRef: null, note: "card declined" };
registerBillingAdapter("failtest", () => ({
  provider: "failtest",
  description: "In-process failing provider for tests.",
  supportsSelfServe: true,
  async createSubscription() {
    throw new Error("not used");
  },
  async changePlan() {
    if (nextOutcome instanceof Error) throw nextOutcome;
    return nextOutcome;
  },
  async cancelSubscription() {
    throw new Error("not used");
  },
  async customerPortalUrl() {
    return null;
  },
}));

// ---- Fake alert sender: records alerts, programmable failure. ----
const alerts = [];
let alertShouldThrow = false;
setPlanChangeAlertSenderForTests(async (alert) => {
  if (alertShouldThrow) throw new Error("smtp down");
  alerts.push(alert);
  return { sent: true };
});

let orgId;

async function subRow() {
  const { rows } = await db.query(
    `SELECT plan_id, pending_plan_id, pending_plan_failed_attempts, pending_plan_failure_alerted_at
     FROM org_subscriptions WHERE organization_id = $1`,
    [orgId],
  );
  return rows[0];
}

async function resetSub() {
  await db.query(
    `INSERT INTO org_subscriptions (organization_id, plan_id, status, billing_provider, billing_ref)
     VALUES ($1, 'pro', 'active', 'failtest', 'sub_orig')
     ON CONFLICT (organization_id) DO UPDATE SET
       plan_id = 'pro', status = 'active', billing_provider = 'failtest', billing_ref = 'sub_orig',
       pending_plan_id = NULL, pending_plan_effective_at = NULL,
       pending_plan_failed_attempts = 0, pending_plan_failure_alerted_at = NULL`,
    [orgId],
  );
}

before(async () => {
  await db.connect();
  await db.query("DELETE FROM organizations WHERE slug LIKE 'test-pcfa%'");
  const { rows } = await db.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [
    `Failure Alert Test ${RUN}`,
    `test-${RUN}`,
  ]);
  orgId = rows[0].id;
});

after(async () => {
  await db.query("DELETE FROM organizations WHERE slug LIKE 'test-pcfa%'");
  await db.end();
});

beforeEach(() => {
  alerts.length = 0;
  alertShouldThrow = false;
  nextOutcome = { ok: false, providerRef: null, note: "card declined" };
});

test("failures below the threshold count up but do not alert", async () => {
  await resetSub();
  await schedulePendingPlanChange(orgId, "core", new Date(Date.now() - 3600 * 1000));

  for (let i = 1; i < PLAN_CHANGE_FAILURE_ALERT_THRESHOLD; i++) {
    await applyDuePendingPlanChanges(new Date(), orgId);
    const row = await subRow();
    assert.equal(Number(row.pending_plan_failed_attempts), i, `attempt ${i} counted`);
    assert.equal(row.pending_plan_failure_alerted_at, null, "no alert claim below threshold");
  }
  assert.equal(alerts.length, 0, "no admin alert below the threshold");

  const failing = await listFailingPlanChanges();
  const mine = failing.find((f) => f.organizationId === orgId);
  assert.ok(mine, "failing change surfaces for the admin page");
  assert.equal(mine.failedAttempts, PLAN_CHANGE_FAILURE_ALERT_THRESHOLD - 1);
  assert.equal(mine.planId, "pro");
  assert.equal(mine.pendingPlanId, "core");
});

test("the threshold pass alerts admins exactly once, later failures stay silent", async () => {
  // Continues from the previous test's counter (threshold - 1 failures so far).
  await applyDuePendingPlanChanges(new Date(), orgId);
  assert.equal(alerts.length, 1, "alert sent at the threshold");
  assert.equal(alerts[0].organizationId, orgId);
  assert.equal(alerts[0].failedAttempts, PLAN_CHANGE_FAILURE_ALERT_THRESHOLD);
  assert.equal(alerts[0].billingProvider, "failtest");
  assert.equal(alerts[0].billingNote, "card declined");
  assert.equal(alerts[0].fromPlanId, "pro");
  assert.equal(alerts[0].toPlanId, "core");

  let row = await subRow();
  assert.ok(row.pending_plan_failure_alerted_at, "alert claim recorded");
  assert.equal(row.pending_plan_id, "core", "pending change still intact for retry");

  const audit = await db.query(
    "SELECT 1 FROM audit_logs WHERE organization_id = $1 AND action = 'subscription.scheduled_change_failure_alerted'",
    [orgId],
  );
  assert.equal(audit.rowCount, 1, "alert audit-logged once");

  // Two more failing passes: counter climbs, no second alert.
  await applyDuePendingPlanChanges(new Date(), orgId);
  await applyDuePendingPlanChanges(new Date(), orgId);
  assert.equal(alerts.length, 1, "alert sent once, not every pass");
  row = await subRow();
  assert.equal(Number(row.pending_plan_failed_attempts), PLAN_CHANGE_FAILURE_ALERT_THRESHOLD + 2);
});

test("a successful apply resets the counter and alert claim", async () => {
  nextOutcome = { ok: true, providerRef: "sub_ok", note: "changed" };
  const applied = await applyDuePendingPlanChanges(new Date(), orgId);
  assert.equal(applied.length, 1, "retry finally succeeds");

  const row = await subRow();
  assert.equal(row.plan_id, "core");
  assert.equal(row.pending_plan_id, null);
  assert.equal(Number(row.pending_plan_failed_attempts), 0, "counter reset on success");
  assert.equal(row.pending_plan_failure_alerted_at, null, "alert claim reset on success");
  assert.equal((await listFailingPlanChanges()).find((f) => f.organizationId === orgId), undefined);
});

test("rescheduling resets the counter so a new change gets its own threshold", async () => {
  await resetSub();
  await schedulePendingPlanChange(orgId, "core", new Date(Date.now() - 3600 * 1000));
  await applyDuePendingPlanChanges(new Date(), orgId);
  assert.equal(Number((await subRow()).pending_plan_failed_attempts), 1);

  await schedulePendingPlanChange(orgId, "core", new Date(Date.now() - 3600 * 1000));
  const row = await subRow();
  assert.equal(Number(row.pending_plan_failed_attempts), 0, "reschedule resets the counter");
  assert.equal(row.pending_plan_failure_alerted_at, null);
});

test("a failed alert delivery releases the claim so the next pass retries the alert", async () => {
  await resetSub();
  await schedulePendingPlanChange(orgId, "core", new Date(Date.now() - 3600 * 1000));
  for (let i = 0; i < PLAN_CHANGE_FAILURE_ALERT_THRESHOLD - 1; i++) await applyDuePendingPlanChanges(new Date(), orgId);

  alertShouldThrow = true;
  await applyDuePendingPlanChanges(new Date(), orgId);
  assert.equal(alerts.length, 0, "delivery failed");
  let row = await subRow();
  assert.equal(row.pending_plan_failure_alerted_at, null, "claim released after delivery failure");

  alertShouldThrow = false;
  await applyDuePendingPlanChanges(new Date(), orgId);
  assert.equal(alerts.length, 1, "next failing pass retries the alert");
  row = await subRow();
  assert.ok(row.pending_plan_failure_alerted_at);
});
