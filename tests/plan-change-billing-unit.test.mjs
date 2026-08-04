/**
 * applyDuePendingPlanChanges × billing adapter tests: when a scheduled
 * downgrade comes due, the org's billing adapter changePlan is invoked at
 * application time (never at scheduling time), and a provider failure leaves
 * the pending change intact for retry on the next pass.
 *
 * Imports the server lib directly (loader stubs "server-only") so a fake
 * billing adapter can be registered in-process. Requires DATABASE_URL.
 *
 * Run alone (never in a parallel `npm test` against next dev):
 *   node --test tests/plan-change-billing-unit.test.mjs
 */
import { register } from "node:module";
register("./helpers/server-lib-loader.mjs", import.meta.url);

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const { registerBillingAdapter } = await import("../lib/billing.ts");
const { applyDuePendingPlanChanges, schedulePendingPlanChange } = await import("../lib/subscriptions.ts");

const RUN = `pcb${Date.now().toString(36)}`;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

// ---- Fake provider: records changePlan calls, programmable outcome. ----
const calls = [];
let nextOutcome = { ok: true, providerRef: "sub_fake_1", note: "changed" };
registerBillingAdapter("faketest", () => ({
  provider: "faketest",
  description: "In-process fake provider for tests.",
  supportsSelfServe: true,
  async createSubscription() {
    throw new Error("createSubscription should not be called by scheduled changes");
  },
  async changePlan(input) {
    calls.push({ ...input });
    if (nextOutcome instanceof Error) throw nextOutcome;
    const { delayMs, ...result } = nextOutcome;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return result;
  },
  async cancelSubscription() {
    throw new Error("cancelSubscription should not be called by scheduled changes");
  },
  async customerPortalUrl() {
    return null;
  },
}));

let orgId;

async function subRow() {
  const { rows } = await db.query(
    "SELECT plan_id, pending_plan_id, pending_plan_effective_at, billing_ref FROM org_subscriptions WHERE organization_id = $1",
    [orgId],
  );
  return rows[0];
}

async function resetSub({ billingRef = "sub_orig" } = {}) {
  await db.query(
    `INSERT INTO org_subscriptions (organization_id, plan_id, status, billing_provider, billing_ref)
     VALUES ($1, 'pro', 'active', 'faketest', $2)
     ON CONFLICT (organization_id) DO UPDATE SET
       plan_id = 'pro', status = 'active', billing_provider = 'faketest', billing_ref = $2,
       pending_plan_id = NULL, pending_plan_effective_at = NULL`,
    [orgId, billingRef],
  );
}

before(async () => {
  await db.connect();
  await db.query("DELETE FROM organizations WHERE slug LIKE 'test-pcb%'");
  const { rows } = await db.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [
    `Billing Apply Test ${RUN}`,
    `test-${RUN}`,
  ]);
  orgId = rows[0].id;
});

after(async () => {
  await db.query("DELETE FROM organizations WHERE slug LIKE 'test-pcb%'");
  await db.end();
});

beforeEach(() => {
  calls.length = 0;
  nextOutcome = { ok: true, providerRef: "sub_fake_1", note: "changed" };
});

test("scheduling a downgrade does NOT call the provider", async () => {
  await resetSub();
  await schedulePendingPlanChange(orgId, "core", new Date(Date.now() + 24 * 3600 * 1000));
  assert.equal(calls.length, 0, "provider must only be notified at application time");
});

test("a due change calls changePlan before applying, then clears the pending columns", async () => {
  await resetSub();
  await schedulePendingPlanChange(orgId, "core", new Date(Date.now() - 3600 * 1000));

  const applied = await applyDuePendingPlanChanges(new Date(), orgId);
  assert.equal(applied.length, 1);
  assert.deepEqual(
    { organizationId: applied[0].organizationId, fromPlanId: applied[0].fromPlanId, toPlanId: applied[0].toPlanId },
    { organizationId: orgId, fromPlanId: "pro", toPlanId: "core" },
  );

  assert.equal(calls.length, 1, "adapter changePlan invoked exactly once");
  assert.deepEqual(calls[0], { organizationId: orgId, billingRef: "sub_orig", fromPlanId: "pro", toPlanId: "core" });

  const row = await subRow();
  assert.equal(row.plan_id, "core");
  assert.equal(row.pending_plan_id, null);
  assert.equal(row.billing_ref, "sub_fake_1", "provider ref returned by the adapter is persisted");

  const audit = await db.query(
    "SELECT metadata FROM audit_logs WHERE organization_id = $1 AND action = 'subscription.scheduled_change_applied'",
    [orgId],
  );
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0].metadata.billingProvider, "faketest");
});

test("a provider failure (ok:false) leaves the pending change intact for retry", async () => {
  await resetSub();
  await schedulePendingPlanChange(orgId, "core", new Date(Date.now() - 3600 * 1000));
  nextOutcome = { ok: false, providerRef: null, note: "provider rejected the change" };

  const applied = await applyDuePendingPlanChanges(new Date(), orgId);
  assert.equal(applied.length, 0, "nothing applied on provider failure");
  assert.equal(calls.length, 1, "provider was attempted");

  const row = await subRow();
  assert.equal(row.plan_id, "pro", "plan unchanged");
  assert.equal(row.pending_plan_id, "core", "pending change kept for retry");
  assert.equal(row.billing_ref, "sub_orig", "billing ref untouched");

  const failLog = await db.query(
    "SELECT metadata FROM audit_logs WHERE organization_id = $1 AND action = 'subscription.scheduled_change_failed'",
    [orgId],
  );
  assert.ok(failLog.rowCount >= 1, "failure audit-logged");
  assert.equal(failLog.rows[0].metadata.billingNote, "provider rejected the change");
});

test("a provider exception is treated as a failure, and the next pass retries and succeeds", async () => {
  await resetSub();
  await schedulePendingPlanChange(orgId, "core", new Date(Date.now() - 3600 * 1000));
  nextOutcome = new Error("provider timeout");

  let applied = await applyDuePendingPlanChanges(new Date(), orgId);
  assert.equal(applied.length, 0);
  let row = await subRow();
  assert.equal(row.plan_id, "pro");
  assert.equal(row.pending_plan_id, "core", "pending kept after a thrown provider error");

  // Retry pass with the provider healthy again.
  nextOutcome = { ok: true, providerRef: null, note: "changed on retry" };
  applied = await applyDuePendingPlanChanges(new Date(), orgId);
  assert.equal(applied.length, 1);
  assert.equal(calls.length, 2, "provider called once per pass");

  row = await subRow();
  assert.equal(row.plan_id, "core");
  assert.equal(row.pending_plan_id, null);
  assert.equal(row.billing_ref, "sub_orig", "null providerRef keeps the existing billing ref");
});

test("re-runs after success are no-ops (no duplicate provider calls)", async () => {
  const applied = await applyDuePendingPlanChanges(new Date(), orgId);
  assert.equal(applied.length, 0);
  assert.equal(calls.length, 0, "no pending change → provider never contacted");
});

test("concurrent apply passes call the provider only once per pending change", async () => {
  await resetSub();
  await schedulePendingPlanChange(orgId, "core", new Date(Date.now() - 3600 * 1000));
  // Slow provider so both passes overlap while one holds the row claim.
  nextOutcome = { ok: true, providerRef: "sub_concurrent", note: "changed", delayMs: 300 };

  const [a, b] = await Promise.all([
    applyDuePendingPlanChanges(new Date(), orgId),
    applyDuePendingPlanChanges(new Date(), orgId),
  ]);
  assert.equal(a.length + b.length, 1, "exactly one pass applies the change");
  assert.equal(calls.length, 1, "provider changePlan invoked exactly once across concurrent passes");

  const row = await subRow();
  assert.equal(row.plan_id, "core");
  assert.equal(row.pending_plan_id, null);
  assert.equal(row.billing_ref, "sub_concurrent");
});

test("manual-provider orgs still apply without a registered provider", async () => {
  await db.query(
    "UPDATE org_subscriptions SET plan_id = 'pro', billing_provider = 'manual', billing_ref = NULL, pending_plan_id = NULL WHERE organization_id = $1",
    [orgId],
  );
  await schedulePendingPlanChange(orgId, "core", new Date(Date.now() - 3600 * 1000));

  const applied = await applyDuePendingPlanChanges(new Date(), orgId);
  assert.equal(applied.length, 1);
  assert.equal(calls.length, 0, "fake provider not involved for manual orgs");
  const row = await subRow();
  assert.equal(row.plan_id, "core");
  assert.equal(row.pending_plan_id, null);
});
