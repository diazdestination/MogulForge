/**
 * Integration test for bot_trap_hits retention cleanup:
 * - rows older than the retention window are deleted by the log-cleanup cron
 * - rows within the window are kept
 * - the cron route rejects unauthenticated calls
 *
 * Requires the dev server on port 5000, DATABASE_URL, and CRON_SECRET.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const BASE = process.env.TEST_BASE_URL ?? "http://127.0.0.1:5000";
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

const state = {};

async function cleanup() {
  await db.query("DELETE FROM bot_trap_hits WHERE reason = 'too_fast' AND created_at < now() - interval '25 days'");
  if (state.freshId) {
    await db.query("DELETE FROM bot_trap_hits WHERE id = $1", [state.freshId]);
  }
}

before(async () => {
  await db.connect();

  // Ensure table exists (idempotent).
  await db.query(`CREATE TABLE IF NOT EXISTS bot_trap_hits (
    id bigserial PRIMARY KEY,
    reason text NOT NULL CHECK (reason IN ('honeypot', 'missing_elapsed', 'too_fast')),
    created_at timestamptz NOT NULL DEFAULT now()
  )`);

  // Old row that should be pruned (35 days ago).
  const old = await db.query(
    `INSERT INTO bot_trap_hits (reason, created_at)
     VALUES ('too_fast', now() - interval '35 days') RETURNING id`,
  );
  state.oldId = old.rows[0].id;

  // Recent row that must survive (1 day ago).
  const fresh = await db.query(
    `INSERT INTO bot_trap_hits (reason, created_at)
     VALUES ('too_fast', now() - interval '1 day') RETURNING id`,
  );
  state.freshId = fresh.rows[0].id;
});

after(async () => {
  await cleanup();
  await db.end();
});

test("log-cleanup rejects calls without the secret", async () => {
  const res = await fetch(`${BASE}/api/cron/log-cleanup`, { method: "POST" });
  assert.equal(res.status, 401);
});

test("log-cleanup deletes old bot_trap_hits and keeps recent ones", async () => {
  const res = await fetch(`${BASE}/api/cron/log-cleanup`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(typeof body.botTrapHits === "number", `expected botTrapHits in response, got: ${JSON.stringify(body)}`);
  assert.ok(body.botTrapHits >= 1, `expected at least 1 deleted hit, got ${body.botTrapHits}`);

  // Old row must be gone.
  const { rows: oldRows } = await db.query("SELECT id FROM bot_trap_hits WHERE id = $1", [state.oldId]);
  assert.equal(oldRows.length, 0, "old bot_trap_hits row should have been deleted");

  // Recent row must survive.
  const { rows: freshRows } = await db.query("SELECT id FROM bot_trap_hits WHERE id = $1", [state.freshId]);
  assert.equal(freshRows.length, 1, "recent bot_trap_hits row must survive");
});

test("log-cleanup records a scheduler heartbeat when called with CRON_SECRET", async () => {
  // Ensure the cron_heartbeats table exists before querying it directly.
  await db.query(`CREATE TABLE IF NOT EXISTS cron_heartbeats (
    job text PRIMARY KEY,
    last_success_at timestamptz NOT NULL DEFAULT now()
  )`);

  const before = new Date();
  const res = await fetch(`${BASE}/api/cron/log-cleanup`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  assert.equal(res.status, 200);

  // The route must have upserted a heartbeat row for "log-cleanup".
  const { rows } = await db.query(
    "SELECT last_success_at FROM cron_heartbeats WHERE job = 'log-cleanup'",
  );
  assert.equal(rows.length, 1, "cron_heartbeats must contain a row for log-cleanup");
  const lastSuccessAt = new Date(rows[0].last_success_at);
  assert.ok(
    lastSuccessAt >= before,
    `heartbeat timestamp ${lastSuccessAt.toISOString()} should be at or after the request start ${before.toISOString()}`,
  );
});
