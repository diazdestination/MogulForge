/**
 * Analysis run-control reliability tests, over live HTTP + the real database:
 * - the DB-level one-active-run-per-org guarantee (partial unique index)
 * - simultaneous run starts: exactly one wins, nothing is analyzed twice
 * - orphan recovery: stale runs are reaped and leads stranded in 'analyzing'
 *   are reclaimed and finish on the next run
 *
 * Uses suppressed/opted-out leads on purpose: they are analyzed by rules alone
 * (no OpenAI calls), so these tests are fast and free.
 *
 * Requires the dev server on port 5000, DATABASE_URL, and ADMIN_PASSWORD.
 *
 *   npm test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const BASE = process.env.TEST_BASE_URL ?? "http://127.0.0.1:5000";
const RUN = `ar${Date.now().toString(36)}`;
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
  const json = (response.headers.get("content-type") ?? "").includes("application/json")
    ? await response.json().catch(() => null)
    : null;
  return { status: response.status, json, cookie: sessionCookie };
}

/** Seeds N opted-out leads directly (rules-only analysis: no AI calls). */
async function seedSuppressedLeads(orgId, count, prefix) {
  await db.query(
    `INSERT INTO rescue_leads (organization_id, first_name, email, email_normalized, consent_status, suppressed, suppression_reason)
     SELECT $1, 'Lead ' || i, $2 || i || '@rescue-test.local', $2 || i || '@rescue-test.local', 'opted_out', true, 'Opt-out in imported file'
     FROM generate_series(1, $3::int) AS i`,
    [orgId, `${prefix}-`, count],
  );
}

async function pollRunsSettled(orgId, cookie, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request(`/api/orgs/${orgId}/analysis`, { cookie });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    if (!res.json.activeRun && res.json.runs.every((run) => run.status !== "running")) return res.json.runs;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Analysis runs did not settle in time.");
}

const state = {};

async function cleanup() {
  await db.query("DELETE FROM organizations WHERE slug LIKE 'test-ar%'");
  await db.query("DELETE FROM users WHERE email LIKE '%@rescue-analysis-test.local'");
}

before(async () => {
  await db.connect();
  await cleanup();

  assert.ok(process.env.ADMIN_PASSWORD, "ADMIN_PASSWORD must be set for tests");
  const adminLogin = await request("/api/admin/session", { method: "POST", body: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(adminLogin.status, 200);

  const provision = await request("/api/admin/organizations", {
    method: "POST",
    cookie: adminLogin.cookie,
    body: {
      name: `Test ${RUN} Analysis`,
      slug: `test-${RUN}`,
      plan: "growth",
      modules: ["revenue_rescue", "lead_import", "ai_analysis"],
      usageLimits: { seats: 5 },
      allowedOrigins: [],
      owner: { email: `owner-${RUN}@rescue-analysis-test.local`, name: "Owner" },
    },
  });
  assert.equal(provision.status, 201, JSON.stringify(provision.json));
  state.org = provision.json.organizationId;

  const accept = await request("/api/invites/accept", {
    method: "POST",
    body: { token: provision.json.inviteToken, name: "Owner", password: "password-ar-123" },
  });
  assert.equal(accept.status, 200);
  state.owner = accept.cookie;
});

after(async () => {
  await cleanup();
  await db.end();
});

test("the database rejects a second concurrent 'running' run for the same org", async () => {
  await db.query("INSERT INTO lead_analysis_runs (organization_id, status) VALUES ($1, 'running')", [state.org]);
  await assert.rejects(
    () => db.query("INSERT INTO lead_analysis_runs (organization_id, status) VALUES ($1, 'running')", [state.org]),
    (error) => error.code === "23505", // unique_violation from lead_analysis_runs_one_active_idx
  );
  // A completed run does not block a new running one.
  await db.query("UPDATE lead_analysis_runs SET status = 'complete' WHERE organization_id = $1", [state.org]);
  await db.query("INSERT INTO lead_analysis_runs (organization_id, status) VALUES ($1, 'running')", [state.org]);
  await db.query("DELETE FROM lead_analysis_runs WHERE organization_id = $1", [state.org]);
});

test("simultaneous run starts: exactly one wins and every lead is analyzed exactly once", async () => {
  await seedSuppressedLeads(state.org, 200, `${RUN}-race`);

  const [a, b] = await Promise.all([
    request(`/api/orgs/${state.org}/analysis`, { method: "POST", cookie: state.owner, body: {} }),
    request(`/api/orgs/${state.org}/analysis`, { method: "POST", cookie: state.owner, body: {} }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.equal(statuses.filter((s) => s === 202).length, 1, `expected exactly one 202, got ${JSON.stringify(statuses)}`);
  // The loser is rejected: 409 (run in progress) or 400 (queue already drained).
  assert.ok([400, 409].includes(statuses.find((s) => s !== 202)), `unexpected loser status ${JSON.stringify(statuses)}`);

  const runs = await pollRunsSettled(state.org, state.owner);
  const totalAnalyzed = runs.reduce((sum, run) => sum + run.analyzedCount, 0);
  assert.equal(totalAnalyzed, 200, "each lead must be analyzed exactly once across all runs");

  const { rows } = await db.query(
    "SELECT count(*)::int AS n FROM rescue_leads WHERE organization_id = $1 AND analysis_status = 'analyzed' AND category = 'do_not_contact' AND score = 0",
    [state.org],
  );
  assert.equal(rows[0].n, 200);
});

test("stale runs are reaped and stranded 'analyzing' leads are reclaimed by the next run", async () => {
  // Simulate a crash mid-run: a 'running' run and leads stuck in 'analyzing',
  // both with no progress updates for 20 minutes.
  await seedSuppressedLeads(state.org, 3, `${RUN}-orphan`);
  await db.query(
    `UPDATE rescue_leads SET analysis_status = 'analyzing', updated_at = now() - interval '20 minutes'
     WHERE organization_id = $1 AND email_normalized LIKE $2`,
    [state.org, `${RUN}-orphan-%`],
  );
  const staleRun = await db.query(
    `INSERT INTO lead_analysis_runs (organization_id, status, total_count, updated_at, created_at)
     VALUES ($1, 'running', 3, now() - interval '20 minutes', now() - interval '25 minutes') RETURNING id`,
    [state.org],
  );

  // A stale 'running' row does not block the next start — it gets reaped.
  const start = await request(`/api/orgs/${state.org}/analysis`, { method: "POST", cookie: state.owner, body: {} });
  assert.equal(start.status, 202, JSON.stringify(start.json));

  const runs = await pollRunsSettled(state.org, state.owner);
  const reaped = runs.find((run) => run.id === staleRun.rows[0].id);
  assert.equal(reaped.status, "failed");
  assert.match(reaped.error ?? "", /interrupted/i);

  // The stranded leads finished on the new run — none left behind.
  const { rows } = await db.query(
    "SELECT analysis_status, count(*)::int AS n FROM rescue_leads WHERE organization_id = $1 AND email_normalized LIKE $2 GROUP BY analysis_status",
    [state.org, `${RUN}-orphan-%`],
  );
  assert.deepEqual(rows, [{ analysis_status: "analyzed", n: 3 }]);
});

test("a fresh active run is NOT reaped and still blocks new starts", async () => {
  await db.query("INSERT INTO lead_analysis_runs (organization_id, status) VALUES ($1, 'running')", [state.org]);
  const blocked = await request(`/api/orgs/${state.org}/analysis`, { method: "POST", cookie: state.owner, body: {} });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.code, "run_in_progress");
  await db.query("DELETE FROM lead_analysis_runs WHERE organization_id = $1 AND status = 'running'", [state.org]);
});
