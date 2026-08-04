/**
 * End-to-end test: the real plan-change failure alert path (defaultSender →
 * RESEND_API_KEY + LEAD_DIGEST_TO) fires once at the threshold and never
 * double-sends. The audit log records subscription.scheduled_change_failure_alerted.
 *
 * The test exercises the real defaultSender code without swapping it for a
 * fake. global.fetch is intercepted so that Resend calls are captured and
 * short-circuited with a canned success response — this keeps the test
 * deterministic and network-free while still catching bugs in the sender
 * (env-var lookup, payload shape, auth header) and the claim/audit logic.
 *
 * RESEND_API_KEY and LEAD_DIGEST_TO must be set; the test exits early when
 * they are absent (CI or dev without credentials).
 *
 * Imports the server lib directly (loader stubs "server-only"). Requires
 * DATABASE_URL. Run alone (never in a parallel `npm test` against next dev):
 *   node --test tests/plan-change-failure-alert.test.mjs
 */
import { register } from "node:module";
register("./helpers/server-lib-loader.mjs", import.meta.url);

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

// ---- Skip guard: abort early when live-delivery env vars are absent. ----
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const LEAD_DIGEST_TO = process.env.LEAD_DIGEST_TO;
if (!RESEND_API_KEY || !LEAD_DIGEST_TO) {
  console.log(
    "plan-change-failure-alert.test.mjs: RESEND_API_KEY / LEAD_DIGEST_TO not set — skipping live delivery tests.",
  );
  process.exit(0);
}

// ---- Intercept global.fetch to capture Resend calls without network I/O. ----
// The real defaultSender is used (no sender swap), so this catches any bug in
// env-var lookup, auth header, or payload construction — and confirms the
// claim+audit path runs to completion.
const resendCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.includes("api.resend.com")) {
    resendCalls.push({ url, body: JSON.parse(init?.body ?? "{}"), headers: Object.fromEntries(new Headers(init?.headers ?? {}).entries()) });
    return new Response(JSON.stringify({ id: `fake-resend-${resendCalls.length}` }), { status: 200 });
  }
  return realFetch(input, init);
};

const { registerBillingAdapter } = await import("../lib/billing.ts");
const { applyDuePendingPlanChanges, schedulePendingPlanChange } = await import("../lib/subscriptions.ts");
const { PLAN_CHANGE_FAILURE_ALERT_THRESHOLD } = await import("../lib/plan-change-alerts.ts");

const RUN = `pcflive${Date.now().toString(36)}`;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

// ---- Fake provider: always fails so we can drive the counter to threshold. ----
registerBillingAdapter("failtest-live", () => ({
  provider: "failtest-live",
  description: "In-process failing provider for live-alert tests.",
  supportsSelfServe: true,
  async createSubscription() { throw new Error("not used"); },
  async changePlan() {
    return { ok: false, providerRef: null, note: "card declined (live test)" };
  },
  async cancelSubscription() { throw new Error("not used"); },
  async customerPortalUrl() { return null; },
}));

let orgId;

/**
 * Returns a `now` value 300 minutes ahead of real time so every pass reaches
 * the provider regardless of the exponential-backoff window (capped at 240 min).
 */
function farAhead() {
  return new Date(Date.now() + 300 * 60 * 1000);
}

async function subRow() {
  const { rows } = await db.query(
    `SELECT pending_plan_id, pending_plan_failed_attempts, pending_plan_failure_alerted_at
     FROM org_subscriptions WHERE organization_id = $1`,
    [orgId],
  );
  return rows[0];
}

async function alertAuditCount() {
  const { rows } = await db.query(
    "SELECT count(*)::int AS n FROM audit_logs WHERE organization_id = $1 AND action = 'subscription.scheduled_change_failure_alerted'",
    [orgId],
  );
  return rows[0].n;
}

async function cleanup() {
  await db.query("DELETE FROM organizations WHERE slug LIKE 'test-pcflive%'");
}

before(async () => {
  await db.connect();
  await cleanup();

  const { rows } = await db.query(
    "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
    [`Plan Change Failure Alert Live ${RUN}`, `test-${RUN}`],
  );
  orgId = rows[0].id;

  // Give the org a subscription on the failtest-live billing provider.
  await db.query(
    `INSERT INTO org_subscriptions (organization_id, plan_id, status, billing_provider, billing_ref)
     VALUES ($1, 'pro', 'active', 'failtest-live', 'sub_live_test')
     ON CONFLICT (organization_id) DO UPDATE SET
       plan_id = 'pro', status = 'active', billing_provider = 'failtest-live', billing_ref = 'sub_live_test',
       pending_plan_id = NULL, pending_plan_effective_at = NULL,
       pending_plan_failed_attempts = 0, pending_plan_failure_alerted_at = NULL,
       pending_plan_last_failed_at = NULL`,
    [orgId],
  );

  // Schedule a pending change already due (in the past) so every pass processes it.
  await schedulePendingPlanChange(orgId, "core", new Date(Date.now() - 3600 * 1000));
});

after(async () => {
  await cleanup();
  await db.end();
  globalThis.fetch = realFetch;
});

test("failures below the threshold do not call Resend or write an alert audit entry", async () => {
  for (let i = 1; i < PLAN_CHANGE_FAILURE_ALERT_THRESHOLD; i++) {
    await applyDuePendingPlanChanges(farAhead(), orgId);
    const row = await subRow();
    assert.equal(Number(row.pending_plan_failed_attempts), i, `attempt ${i} counted`);
    assert.equal(row.pending_plan_failure_alerted_at, null, "no alert claim below threshold");
  }
  assert.equal(resendCalls.length, 0, "Resend not called below the threshold");
  assert.equal(await alertAuditCount(), 0, "no alert audit entry below the threshold");
});

test("the threshold pass calls Resend with the right payload and records the audit entry", async () => {
  // This is the PLAN_CHANGE_FAILURE_ALERT_THRESHOLD-th failure.
  await applyDuePendingPlanChanges(farAhead(), orgId);

  // One Resend call must have been made with the real credentials.
  assert.equal(resendCalls.length, 1, "exactly one Resend call at the threshold");
  const call = resendCalls[0];
  assert.match(call.headers["authorization"] ?? "", /^Bearer re_/, "Authorization header carries the real API key");
  assert.equal(call.body.to, LEAD_DIGEST_TO, "email addressed to LEAD_DIGEST_TO");
  assert.match(call.body.subject, /scheduled plan change/, "subject mentions the plan change");
  assert.match(call.body.html, /card declined \(live test\)/, "html includes the provider failure note");
  assert.match(call.body.html, /failtest-live/, "html names the billing provider");
  assert.ok(call.body.from, "from address is set");

  // DB claim must be recorded.
  const row = await subRow();
  assert.ok(row.pending_plan_failure_alerted_at, "alert claim recorded in DB");
  assert.equal(row.pending_plan_id, "core", "pending change still intact for retry");

  // Audit entry is the authoritative record that delivery succeeded.
  assert.equal(await alertAuditCount(), 1, "exactly one alert audit entry written");
});

test("subsequent failing passes do not call Resend again", async () => {
  const callsBefore = resendCalls.length;

  // Two more passes after the claim is set.
  await applyDuePendingPlanChanges(farAhead(), orgId);
  await applyDuePendingPlanChanges(farAhead(), orgId);

  assert.equal(resendCalls.length, callsBefore, "no additional Resend calls after the claim is set");
  assert.equal(await alertAuditCount(), 1, "audit count stays at 1 — no double-send");

  const row = await subRow();
  assert.equal(
    Number(row.pending_plan_failed_attempts),
    PLAN_CHANGE_FAILURE_ALERT_THRESHOLD + 2,
    "failure counter increments on each pass",
  );
  assert.ok(row.pending_plan_failure_alerted_at, "alert claim still held");
});
