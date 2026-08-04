/**
 * Integration test for scheduled CRM pull auto-error — against the real database,
 * calling the sync lib directly (real provider API answers 401 for the fake token):
 * - a scheduled pull failure increments the connection's consecutive failure counter
 * - crossing the threshold flips the connection to status 'error' and audits it
 * - errored connections are skipped by later scheduler passes
 * - a manual (non-scheduled) pull failure does not increment the counter
 *
 * Requires DATABASE_URL.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import pg from "pg";

register("./helpers/server-lib-loader.mjs", import.meta.url);
const { runScheduledCrmPulls, pullCrmUpdates, SCHEDULED_PULL_AUTO_ERROR_FAILURES } = await import("../lib/crm/sync.ts");
const { getCrmConnection } = await import("../lib/crm/store.ts");

const RUN = `crmerr${Date.now().toString(36)}`;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const state = {};

async function cleanup() {
  await db.query("DELETE FROM organizations WHERE slug LIKE 'test-crmerr%'");
}

/** Seeds the connection one failure below the threshold, with a stale lastPull so the scheduler picks it up. */
async function seedFailures(count) {
  await db.query(
    `UPDATE crm_connections SET status = 'active', last_test_result = jsonb_build_object(
       'ok', true,
       'lastPull', jsonb_build_object('at', (now() - interval '1 hour')::text, 'ok', false, 'consecutiveFailures', $2::int)
     ) WHERE id = $1`,
    [state.connId, count],
  );
}

before(async () => {
  await db.connect();
  await cleanup();
  const org = await db.query(`INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`, [`Test ${RUN}`, `test-${RUN}`]);
  state.orgId = org.rows[0].id;
  const conn = await db.query(
    `INSERT INTO crm_connections (organization_id, provider, name, config, status, sync_direction)
     VALUES ($1, 'hubspot', 'auto-error test', '{"accessToken":"pat-na1-not-a-real-token"}'::jsonb, 'active', 'inbound') RETURNING id`,
    [state.orgId],
  );
  state.connId = conn.rows[0].id;
});

after(async () => {
  await cleanup();
  await db.end();
});

test("scheduled pull failure below threshold increments counter but keeps connection active", async () => {
  await seedFailures(1);
  await runScheduledCrmPulls();
  const conn = await getCrmConnection(state.orgId, String(state.connId));
  assert.equal(conn.status, "active");
  assert.equal(conn.lastTestResult.lastPull.ok, false);
  assert.equal(conn.lastTestResult.lastPull.consecutiveFailures, 2);
});

test("crossing the threshold flips the connection to 'error' and writes the audit trail", async () => {
  await seedFailures(SCHEDULED_PULL_AUTO_ERROR_FAILURES - 1);
  await runScheduledCrmPulls();
  const conn = await getCrmConnection(state.orgId, String(state.connId));
  assert.equal(conn.status, "error");
  assert.equal(conn.lastTestResult.lastPull.consecutiveFailures, SCHEDULED_PULL_AUTO_ERROR_FAILURES);
  const audit = await db.query(
    `SELECT action FROM audit_logs WHERE organization_id = $1 AND target_id = $2::text AND action = 'crm_connection.auto_errored'`,
    [state.orgId, state.connId],
  );
  assert.equal(audit.rows.length, 1);
});

test("errored connections are skipped by subsequent scheduler passes", async () => {
  const before = await db.query(`SELECT last_test_result->'lastPull'->>'at' AS at FROM crm_connections WHERE id = $1`, [state.connId]);
  const result = await runScheduledCrmPulls();
  assert.equal(result.failed, 0);
  const afterRun = await db.query(`SELECT last_test_result->'lastPull'->>'at' AS at FROM crm_connections WHERE id = $1`, [state.connId]);
  assert.equal(afterRun.rows[0].at, before.rows[0].at); // untouched — no pull attempted
});

test("manual pull failure does not increment the scheduled-failure counter", async () => {
  await seedFailures(3);
  const conn = await getCrmConnection(state.orgId, String(state.connId));
  const summary = await pullCrmUpdates(state.orgId, conn);
  assert.equal(summary.ok, false);
  assert.equal(summary.consecutiveFailures, 3);
});
