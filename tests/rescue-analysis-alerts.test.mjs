/**
 * End-to-end checks that a finished analysis run sends exactly ONE hot-lead
 * summary email (never one per lead), and none when zero hot leads were found
 * or when the run fails outright.
 *
 * Imports the analysis engine directly (loader stubs "server-only") and
 * records outbound Resend calls by stubbing global fetch — no real email is
 * sent. OPENAI_API_KEY is removed from the test process so every run is
 * deterministic-only (fast, free, and score-predictable).
 *
 * Requires DATABASE_URL. Run alone (never in a parallel `npm test`):
 *   node --test tests/rescue-analysis-alerts.test.mjs
 */
import { register } from "node:module";
register("./helpers/server-lib-loader.mjs", import.meta.url);

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

process.env.RESEND_API_KEY ||= "re_test_fake_key";
delete process.env.OPENAI_API_KEY; // deterministic-only runs: no AI calls

// ---- Record outbound Resend sends; block any accidental real delivery. ----
const sentEmails = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.includes("api.resend.com")) {
    sentEmails.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: `fake-${sentEmails.length}` }), { status: 200 });
  }
  return realFetch(input, init);
};
const sendsTo = (address) => sentEmails.filter((e) => (Array.isArray(e.to) ? e.to : [e.to]).includes(address));

const { startAnalysisRun } = await import("../lib/rescue-analysis/engine.ts");

const RUN = `hotal${Date.now().toString(36)}`;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const email = (tag) => `${tag}-${RUN}@analysis-alerts-test.local`;

async function createOrg(suffix, notifications) {
  const { rows } = await db.query(
    `INSERT INTO organizations (name, slug, plan, settings)
     VALUES ($1, $2, 'growth', $3) RETURNING id`,
    [`Analysis Alert Test ${suffix}`, `test-${RUN}-${suffix}`, JSON.stringify({ notifications })],
  );
  return rows[0].id;
}

/**
 * Leads guaranteed hot_opportunity under the deterministic rules:
 * base 40 + both channels 8 + contacted <30d ago 20 + value >= $25k 20
 * + express consent 8 = 96 (>= 70 threshold), no unknown_* flags.
 */
async function seedHotLeads(orgId, count, prefix) {
  await db.query(
    `INSERT INTO rescue_leads (organization_id, first_name, email, email_normalized, phone, phone_normalized,
       estimated_value, last_contact_date, consent_status, suppressed)
     SELECT $1, 'Hot ' || i, $2 || i || '@t.local', $2 || i || '@t.local', '+1555000' || (1000 + i), '+1555000' || (1000 + i),
       30000, (now() - interval '5 days')::date, 'express', false
     FROM generate_series(1, $3::int) AS i`,
    [orgId, `${prefix}-`, count],
  );
}

/** Suppressed/opted-out leads: analyzed by rules alone as do_not_contact, score 0 — never hot. */
async function seedColdLeads(orgId, count, prefix) {
  await db.query(
    `INSERT INTO rescue_leads (organization_id, first_name, email, email_normalized, consent_status, suppressed, suppression_reason)
     SELECT $1, 'Cold ' || i, $2 || i || '@t.local', $2 || i || '@t.local', 'opted_out', true, 'Opt-out on file'
     FROM generate_series(1, $3::int) AS i`,
    [orgId, `${prefix}-`, count],
  );
}

async function waitForRunSettled(orgId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await db.query(
      "SELECT status, analyzed_count, failed_count FROM lead_analysis_runs WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1",
      [orgId],
    );
    if (rows[0] && rows[0].status !== "running") return rows[0];
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Analysis run did not settle in time.");
}

async function waitFor(predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

const notificationsOn = (to) => ({
  hotLeadAlerts: true,
  replyAlerts: true,
  appointmentAlerts: true,
  weeklyDigest: false,
  notificationEmails: [to],
});

async function cleanup() {
  await db.query("DROP TRIGGER IF EXISTS test_fail_analysis_save ON rescue_leads");
  await db.query("DROP FUNCTION IF EXISTS test_fail_analysis_save_fn()");
  await db.query("DELETE FROM organizations WHERE slug LIKE 'test-hotal%'");
}

before(async () => {
  await db.connect();
  await cleanup();
});

after(async () => {
  await cleanup();
  await db.end();
  globalThis.fetch = realFetch;
});

test("a completed run with hot leads sends exactly ONE summary email with the correct count", async () => {
  const to = email("hot");
  const orgId = await createOrg("hot", notificationsOn(to));
  // 6 hot + 3 non-hot leads: the count in the email must be 6, and the send
  // count must be 1 — not one per hot lead, not one per analyzed lead.
  await seedHotLeads(orgId, 6, `${RUN}-hot`);
  await seedColdLeads(orgId, 3, `${RUN}-hotcold`);

  const result = await startAnalysisRun(orgId, { actorLabel: "test" });
  assert.equal(result.started, true, JSON.stringify(result));

  const run = await waitForRunSettled(orgId);
  assert.equal(run.status, "complete");
  assert.equal(run.analyzed_count, 9);

  // The alert is fire-and-forget: wait for it, then hold to catch duplicates.
  assert.ok(await waitFor(() => sendsTo(to).length >= 1), "expected the hot-lead summary email");
  await new Promise((r) => setTimeout(r, 750));
  const sends = sendsTo(to);
  assert.equal(sends.length, 1, `expected exactly one summary send, got ${sends.length}`);
  assert.equal(sends[0].subject, "Analysis found 6 hot opportunities");
  assert.match(sends[0].html, /classified 6 of 9 analyzed leads/);

  // Sanity: the DB agrees 6 leads are hot.
  const { rows } = await db.query(
    "SELECT count(*)::int AS n FROM rescue_leads WHERE organization_id = $1 AND category = 'hot_opportunity'",
    [orgId],
  );
  assert.equal(rows[0].n, 6);
});

test("a completed run with ZERO hot leads sends nothing", async () => {
  const to = email("zero");
  const orgId = await createOrg("zero", notificationsOn(to));
  await seedColdLeads(orgId, 5, `${RUN}-zero`);

  const result = await startAnalysisRun(orgId, { actorLabel: "test" });
  assert.equal(result.started, true, JSON.stringify(result));

  const run = await waitForRunSettled(orgId);
  assert.equal(run.status, "complete");
  assert.equal(run.analyzed_count, 5);

  await new Promise((r) => setTimeout(r, 750));
  assert.equal(sendsTo(to).length, 0, "zero-hot runs must not email anyone");
});

test("a FAILED run sends nothing, even when its leads would have been hot", async () => {
  const to = email("fail");
  const orgId = await createOrg("fail", notificationsOn(to));
  await seedHotLeads(orgId, 4, `${RUN}-fail`);

  // Force every per-lead save to fail for this org only: a trigger that
  // rejects the 'analyzed' status update, so the run ends status='failed'
  // with analyzed_count = 0.
  await db.query(`
    CREATE FUNCTION test_fail_analysis_save_fn() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'test: simulated analysis save failure'; END;
    $$ LANGUAGE plpgsql`);
  await db.query(`
    CREATE TRIGGER test_fail_analysis_save BEFORE UPDATE ON rescue_leads
    FOR EACH ROW WHEN (NEW.organization_id = '${orgId}'::uuid AND NEW.analysis_status = 'analyzed')
    EXECUTE FUNCTION test_fail_analysis_save_fn()`);
  try {
    const result = await startAnalysisRun(orgId, { actorLabel: "test" });
    assert.equal(result.started, true, JSON.stringify(result));

    const run = await waitForRunSettled(orgId);
    assert.equal(run.status, "failed");
    assert.equal(run.analyzed_count, 0);
    assert.equal(run.failed_count, 4);

    await new Promise((r) => setTimeout(r, 750));
    assert.equal(sendsTo(to).length, 0, "failed runs must not email anyone");
  } finally {
    await db.query("DROP TRIGGER IF EXISTS test_fail_analysis_save ON rescue_leads");
    await db.query("DROP FUNCTION IF EXISTS test_fail_analysis_save_fn()");
  }
});
