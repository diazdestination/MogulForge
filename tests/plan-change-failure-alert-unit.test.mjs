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
    `SELECT plan_id, pending_plan_id, pending_plan_failed_attempts, pending_plan_failure_alerted_at,
            pending_plan_last_failed_at
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
       pending_plan_failed_attempts = 0, pending_plan_failure_alerted_at = NULL,
       pending_plan_last_failed_at = NULL`,
    [orgId],
  );
}

/**
 * Returns a `now` value 300 minutes ahead of real time.
 * Used in failure-count tests that aren't testing backoff timing: passing a
 * far-future `now` ensures the backoff window (capped at 240 min) is always
 * considered elapsed so every pass reaches the provider as intended.
 */
function farAhead() {
  return new Date(Date.now() + 300 * 60 * 1000);
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
    await applyDuePendingPlanChanges(farAhead(), orgId);
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
  await applyDuePendingPlanChanges(farAhead(), orgId);
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
  await applyDuePendingPlanChanges(farAhead(), orgId);
  await applyDuePendingPlanChanges(farAhead(), orgId);
  assert.equal(alerts.length, 1, "alert sent once, not every pass");
  row = await subRow();
  assert.equal(Number(row.pending_plan_failed_attempts), PLAN_CHANGE_FAILURE_ALERT_THRESHOLD + 2);
});

test("a successful apply resets the counter and alert claim", async () => {
  nextOutcome = { ok: true, providerRef: "sub_ok", note: "changed" };
  const applied = await applyDuePendingPlanChanges(farAhead(), orgId);
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
  for (let i = 0; i < PLAN_CHANGE_FAILURE_ALERT_THRESHOLD - 1; i++) await applyDuePendingPlanChanges(farAhead(), orgId);

  alertShouldThrow = true;
  await applyDuePendingPlanChanges(farAhead(), orgId);
  assert.equal(alerts.length, 0, "delivery failed");
  let row = await subRow();
  assert.equal(row.pending_plan_failure_alerted_at, null, "claim released after delivery failure");

  alertShouldThrow = false;
  await applyDuePendingPlanChanges(farAhead(), orgId);
  assert.equal(alerts.length, 1, "next failing pass retries the alert");
  row = await subRow();
  assert.ok(row.pending_plan_failure_alerted_at);
});

// ---------------------------------------------------------------------------
// Exponential-backoff tests
// ---------------------------------------------------------------------------

test("an org is skipped on the very next pass after a failure (backoff not yet elapsed)", async () => {
  await resetSub();
  // Effective date already in the past so it is unconditionally due.
  await schedulePendingPlanChange(orgId, "core", new Date(Date.now() - 3600 * 1000));

  // First pass: fails and records last_failed_at ≈ now.
  const t0 = new Date();
  await applyDuePendingPlanChanges(t0, orgId);
  assert.equal(Number((await subRow()).pending_plan_failed_attempts), 1, "first failure counted");

  // Immediate retry (same wall-clock second): still within the 2-minute backoff window.
  const applied = await applyDuePendingPlanChanges(t0, orgId);
  assert.equal(applied.length, 0, "skipped — backoff window not elapsed");
  assert.equal(
    Number((await subRow()).pending_plan_failed_attempts),
    1,
    "counter unchanged while skipped",
  );
});

test("retry is allowed once the backoff window has elapsed", async () => {
  // The sub from the previous test already has 1 failed attempt.
  // Backoff after 1 failure = 2^1 = 2 minutes.  Advance `now` by 3 minutes.
  const tLater = new Date(Date.now() + 3 * 60 * 1000);
  await applyDuePendingPlanChanges(tLater, orgId);
  assert.equal(
    Number((await subRow()).pending_plan_failed_attempts),
    2,
    "second failure counted — retry was allowed",
  );
});

test("backoff grows with each failure and caps at 240 minutes", async () => {
  await resetSub();
  await schedulePendingPlanChange(orgId, "core", new Date(Date.now() - 3600 * 1000));

  const CAPS_AT = 240; // minutes
  const CAP_ATTEMPTS = 8; // 2^8 = 256 > 240, so cap kicks in here

  // Drive up the counter to the cap threshold using a far-future `now` each
  // time so the backoff window is always considered elapsed.
  for (let i = 0; i < CAP_ATTEMPTS; i++) {
    const far = new Date(Date.now() + (CAPS_AT + 1) * 60 * 1000);
    await applyDuePendingPlanChanges(far, orgId);
  }
  const row = await subRow();
  assert.equal(Number(row.pending_plan_failed_attempts), CAP_ATTEMPTS, "counter reached cap threshold");

  // At the cap: a pass exactly CAPS_AT minutes after last_failed_at should be eligible.
  // Directly set last_failed_at to a known time in the past equal to exactly cap minutes.
  const knownBase = new Date(Date.now() - CAPS_AT * 60 * 1000);
  await db.query(
    "UPDATE org_subscriptions SET pending_plan_last_failed_at = $2 WHERE organization_id = $1",
    [orgId, knownBase.toISOString()],
  );
  const atCap = new Date(knownBase.getTime() + CAPS_AT * 60 * 1000);
  const applied = await applyDuePendingPlanChanges(atCap, orgId);
  // Provider still failing, so applied is empty — but the attempt counter
  // increments, proving the org was not skipped.
  assert.equal(
    Number((await subRow()).pending_plan_failed_attempts),
    CAP_ATTEMPTS + 1,
    "retry allowed when capped backoff window has elapsed",
  );
  assert.equal(applied.length, 0, "provider still failing");

  // One second before the cap: org should be skipped.
  const justBefore = new Date(knownBase.getTime() + CAPS_AT * 60 * 1000 - 1000);
  // Reset last_failed_at to knownBase again for a clean measurement.
  await db.query(
    "UPDATE org_subscriptions SET pending_plan_last_failed_at = $2 WHERE organization_id = $1",
    [orgId, knownBase.toISOString()],
  );
  const skipped = await applyDuePendingPlanChanges(justBefore, orgId);
  assert.equal(skipped.length, 0, "skipped while still inside capped window");
  assert.equal(
    Number((await subRow()).pending_plan_failed_attempts),
    CAP_ATTEMPTS + 1,
    "counter unchanged while skipped",
  );
});

test("a successful retry after backoff resets last_failed_at", async () => {
  await resetSub();
  await schedulePendingPlanChange(orgId, "core", new Date(Date.now() - 3600 * 1000));

  // One failure to stamp last_failed_at.
  await applyDuePendingPlanChanges(new Date(), orgId);
  assert.ok((await subRow()).pending_plan_last_failed_at, "last_failed_at is set after failure");

  // Advance time past the backoff and let the provider succeed this time.
  nextOutcome = { ok: true, providerRef: "sub_recovered", note: "ok" };
  const tLater = new Date(Date.now() + 5 * 60 * 1000);
  const applied = await applyDuePendingPlanChanges(tLater, orgId);
  assert.equal(applied.length, 1, "change applied on recovery");

  const row = await subRow();
  assert.equal(row.pending_plan_id, null, "pending change cleared");
  assert.equal(row.pending_plan_last_failed_at, null, "last_failed_at reset on success");
});
