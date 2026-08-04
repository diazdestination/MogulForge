/**
 * Integration test for the CRM push delivery retention pass — over live HTTP
 * against the dev server and the real database:
 * - succeeded rows older than 30 days are deleted
 * - failed rows older than 90 days are deleted
 * - recent succeeded rows and failed rows within 90 days are kept (retries stay possible)
 * - the cron route rejects unauthenticated calls
 *
 * Requires the dev server on port 5000, DATABASE_URL, and CRON_SECRET.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const BASE = process.env.TEST_BASE_URL ?? "http://127.0.0.1:5000";
const RUN = `crmclean${Date.now().toString(36)}`;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

const state = {};

async function cleanup() {
  await db.query("DELETE FROM organizations WHERE slug LIKE 'test-crmclean%'");
}

before(async () => {
  await db.connect();
  await cleanup();
  const org = await db.query(
    `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
    [`Test ${RUN}`, `test-${RUN}`],
  );
  state.orgId = org.rows[0].id;
  const conn = await db.query(
    `INSERT INTO crm_connections (organization_id, provider, name, config)
     VALUES ($1, 'webhook', 'cleanup test', '{"url":"https://example.com"}'::jsonb) RETURNING id`,
    [state.orgId],
  );
  state.connId = conn.rows[0].id;
  const lead = await db.query(
    `INSERT INTO rescue_leads (organization_id, first_name, last_name) VALUES ($1, 'Clean', 'Up') RETURNING id`,
    [state.orgId],
  );
  state.leadId = lead.rows[0].id;

  const insert = async (status, ageDays) => {
    const { rows } = await db.query(
      `INSERT INTO crm_push_deliveries (organization_id, connection_id, lead_id, provider, status, delivered_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'webhook', $4, CASE WHEN $4 = 'succeeded' THEN now() END,
               now() - make_interval(days => $5), now() - make_interval(days => $5)) RETURNING id`,
      [state.orgId, state.connId, state.leadId, status, ageDays],
    );
    return rows[0].id;
  };
  state.oldSucceeded = await insert("succeeded", 45);
  state.freshSucceeded = await insert("succeeded", 5);
  state.oldFailed = await insert("failed", 120);
  state.midFailed = await insert("failed", 60); // older than succeeded cutoff but kept for retries
  state.freshFailed = await insert("failed", 1);
});

after(async () => {
  await cleanup();
  await db.end();
});

test("cron route rejects calls without the secret", async () => {
  const res = await fetch(`${BASE}/api/cron/crm-delivery-cleanup`, { method: "POST" });
  assert.equal(res.status, 401);
});

test("retention pass deletes old rows, keeps recent ones, and records heartbeat", async () => {
  // Note the time just before triggering so we can assert the heartbeat is fresh.
  const before = new Date();

  const res = await fetch(`${BASE}/api/cron/crm-delivery-cleanup`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.succeededDeleted >= 1, JSON.stringify(body));
  assert.ok(body.failedDeleted >= 1, JSON.stringify(body));

  const { rows } = await db.query(`SELECT id FROM crm_push_deliveries WHERE organization_id = $1`, [state.orgId]);
  const remaining = new Set(rows.map((r) => String(r.id)));
  assert.ok(!remaining.has(state.oldSucceeded), "succeeded row older than 30d should be deleted");
  assert.ok(!remaining.has(state.oldFailed), "failed row older than 90d should be deleted");
  assert.ok(remaining.has(state.freshSucceeded), "recent succeeded row must survive");
  assert.ok(remaining.has(state.midFailed), "failed row within 90d must survive so it can be retried");
  assert.ok(remaining.has(state.freshFailed), "recent failed row must survive");

  // The external-auth path must record a heartbeat row in cron_heartbeats.
  const { rows: hbRows } = await db.query(
    `SELECT last_success_at FROM cron_heartbeats WHERE job = 'crm-delivery-cleanup'`,
  );
  assert.ok(hbRows.length === 1, "cron_heartbeats row for 'crm-delivery-cleanup' must exist after a successful external call");
  const lastSuccess = new Date(hbRows[0].last_success_at);
  assert.ok(lastSuccess >= before, `heartbeat timestamp (${lastSuccess.toISOString()}) must be at or after the call time (${before.toISOString()})`);
});
