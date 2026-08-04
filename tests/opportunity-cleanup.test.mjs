/**
 * Integration test for cleanupOldDismissedOpportunities via the log-cleanup cron.
 *
 * Rows deleted:
 *   - status='dismissed' older than 90 days
 *   - status='actioned'  older than 90 days
 *
 * Rows kept:
 *   - status='new'       (any age — open items are never pruned here)
 *   - status='dismissed' within 90-day window
 *   - status='actioned'  within 90-day window
 *
 * Requires the dev server on port 5000, DATABASE_URL, and CRON_SECRET.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const BASE = process.env.TEST_BASE_URL ?? "http://127.0.0.1:5000";
const RUN = `oppclean${Date.now().toString(36)}`;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

const state = {};

async function cleanup() {
  await db.query("DELETE FROM organizations WHERE slug LIKE 'test-oppclean%'");
}

before(async () => {
  await db.connect();
  await cleanup();

  const org = await db.query(
    `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
    [`Test ${RUN}`, `test-${RUN}`],
  );
  state.orgId = org.rows[0].id;

  const insert = async (status, ageDays, dedupSuffix) => {
    const { rows } = await db.query(
      `INSERT INTO org_opportunities
         (organization_id, kind, title, evidence, action_hint, status, dedup_key,
          created_at, updated_at)
       VALUES ($1, 'stale_estimate', 'Test opp', '{}', '', $2, $3,
               now() - make_interval(days => $4),
               now() - make_interval(days => $4))
       RETURNING id`,
      [state.orgId, status, `${RUN}-${dedupSuffix}`, ageDays],
    );
    return rows[0].id;
  };

  // Should be deleted — terminal status older than 90 days
  state.oldDismissed = await insert("dismissed", 91, "old-dismissed");
  state.oldActioned  = await insert("actioned",  95, "old-actioned");

  // Should be kept — terminal status but still within the window
  state.recentDismissed = await insert("dismissed", 30, "recent-dismissed");
  state.recentActioned  = await insert("actioned",  10, "recent-actioned");

  // Should be kept — status='new' is never pruned regardless of age
  state.oldNew    = await insert("new", 120, "old-new");
  state.freshNew  = await insert("new",   1, "fresh-new");
});

after(async () => {
  await cleanup();
  await db.end();
});

test("log-cleanup rejects unauthenticated calls", async () => {
  const res = await fetch(`${BASE}/api/cron/log-cleanup`, { method: "POST" });
  assert.equal(res.status, 401);
});

test("cleanup deletes old dismissed/actioned rows and leaves everything else intact", async () => {
  const res = await fetch(`${BASE}/api/cron/log-cleanup`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  // The cron returns { opportunities: { deleted: N } }
  assert.ok(
    typeof body.opportunities?.deleted === "number" && body.opportunities.deleted >= 2,
    `expected opportunities.deleted >= 2, got ${JSON.stringify(body.opportunities)}`,
  );

  const { rows } = await db.query(
    `SELECT id FROM org_opportunities WHERE organization_id = $1`,
    [state.orgId],
  );
  const remaining = new Set(rows.map((r) => String(r.id)));

  assert.ok(!remaining.has(state.oldDismissed),  "dismissed row older than 90d must be deleted");
  assert.ok(!remaining.has(state.oldActioned),   "actioned row older than 90d must be deleted");
  assert.ok(remaining.has(state.recentDismissed), "dismissed row within 90d must be kept");
  assert.ok(remaining.has(state.recentActioned),  "actioned row within 90d must be kept");
  assert.ok(remaining.has(state.oldNew),           "new row (any age) must never be pruned");
  assert.ok(remaining.has(state.freshNew),         "fresh new row must never be pruned");
});
