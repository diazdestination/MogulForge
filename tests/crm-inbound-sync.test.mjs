/**
 * Integration tests for the inbound CRM sync compare/merge engine in
 * lib/crm/sync.ts (pullCrmUpdates), against the real database with a stubbed
 * global fetch standing in for the provider API:
 * - leads are matched by external_record_id, normalized email, and normalized phone
 * - disagreements where the remote copy is NOT provably newer land in
 *   crm_sync_conflicts (with local/remote values) instead of overwriting the lead
 * - remote changes only auto-apply when provably newer, or when the local
 *   fields are empty (filling blanks is never a conflict)
 * - missing/blank remote fields never null out existing local values
 * - unmatched remote contacts are counted, never inserted
 *
 * Requires DATABASE_URL.
 *   node --test tests/crm-inbound-sync.test.mjs
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import pg from "pg";

register("./helpers/server-lib-loader.mjs", import.meta.url);
const { pullCrmUpdates } = await import("../lib/crm/sync.ts");
const { getCrmConnection } = await import("../lib/crm/store.ts");

const RUN = `crmpull${Date.now().toString(36)}`;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const state = {};

// ---- fetch stub: scripted HubSpot search responses ------------------------
const realFetch = globalThis.fetch;
let scriptedContacts = [];
function hubspotResults(contacts) {
  // Shape contacts the way the HubSpot search API returns them.
  scriptedContacts = contacts.map((c) => ({
    id: c.id,
    properties: {
      ...(c.firstName !== undefined ? { firstname: c.firstName } : {}),
      ...(c.lastName !== undefined ? { lastname: c.lastName } : {}),
      ...(c.email !== undefined ? { email: c.email } : {}),
      ...(c.phone !== undefined ? { phone: c.phone } : {}),
      ...(c.updatedAt !== undefined ? { lastmodifieddate: c.updatedAt } : {}),
    },
  }));
}
globalThis.fetch = async () =>
  new Response(JSON.stringify({ results: scriptedContacts }), { status: 200, headers: { "content-type": "application/json" } });

async function cleanup() {
  await db.query("DELETE FROM organizations WHERE slug LIKE 'test-crmpull%'");
}

/** Inserts a lead and returns its id. */
async function insertLead(fields) {
  const { rows } = await db.query(
    `INSERT INTO rescue_leads (organization_id, first_name, last_name, email, email_normalized, phone, phone_normalized, external_record_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      state.orgId,
      fields.firstName ?? null,
      fields.lastName ?? null,
      fields.email ?? null,
      fields.emailNormalized ?? null,
      fields.phone ?? null,
      fields.phoneNormalized ?? null,
      fields.externalRecordId ?? null,
      fields.updatedAt ?? new Date().toISOString(),
    ],
  );
  return String(rows[0].id);
}

async function leadRow(id) {
  const { rows } = await db.query(`SELECT first_name, last_name, updated_at FROM rescue_leads WHERE id = $1`, [id]);
  return rows[0];
}

async function conflictsFor(leadId) {
  const { rows } = await db.query(
    `SELECT source, fields, local_updated_at, remote_updated_at, status, connection_id
     FROM crm_sync_conflicts WHERE organization_id = $1 AND lead_id = $2 ORDER BY created_at`,
    [state.orgId, leadId],
  );
  return rows;
}

async function pull() {
  const connection = await getCrmConnection(state.orgId, state.connId);
  return pullCrmUpdates(state.orgId, connection);
}

before(async () => {
  await db.connect();
  await cleanup();
  const org = await db.query(`INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`, [`Test ${RUN}`, `test-${RUN}`]);
  state.orgId = org.rows[0].id;
  const conn = await db.query(
    `INSERT INTO crm_connections (organization_id, provider, name, config, status, sync_direction)
     VALUES ($1, 'hubspot', 'inbound sync test', '{"accessToken":"pat-na1-stubbed"}'::jsonb, 'active', 'inbound') RETURNING id`,
    [state.orgId],
  );
  state.connId = String(conn.rows[0].id);
});

after(async () => {
  await cleanup();
  await db.end();
  globalThis.fetch = realFetch;
});

beforeEach(async () => {
  scriptedContacts = [];
  await db.query(`DELETE FROM crm_sync_conflicts WHERE organization_id = $1`, [state.orgId]);
  await db.query(`DELETE FROM rescue_leads WHERE organization_id = $1`, [state.orgId]);
});

// ---- matching ---------------------------------------------------------------

test("matches by normalized email even when remote casing/format differs", async () => {
  const leadId = await insertLead({ firstName: null, lastName: null, email: "casey@example.com", emailNormalized: "casey@example.com" });
  hubspotResults([{ id: "m1", firstName: "Casey", email: "  CASEY@Example.COM " }]);
  const summary = await pull();
  assert.equal(summary.matched, 1);
  assert.equal(summary.unmatched, 0);
  assert.equal(summary.updated, 1); // local fields empty → filled, no conflict
  assert.equal((await leadRow(leadId)).first_name, "Casey");
});

test("matches by normalized phone when email is absent", async () => {
  const leadId = await insertLead({ phone: "(555) 644-9001", phoneNormalized: "5556449001" });
  // normalizePhone strips punctuation but keeps every digit, so the remote
  // format may differ in punctuation only — not in a leading country code.
  hubspotResults([{ id: "m2", firstName: "Pat", phone: "555.644.9001" }]);
  const summary = await pull();
  assert.equal(summary.matched, 1);
  assert.equal((await leadRow(leadId)).first_name, "Pat");
});

test("matches by phone when the remote number carries a +1 country code and the local one does not", async () => {
  const leadId = await insertLead({ phone: "(555) 644-9001", phoneNormalized: "5556449001" });
  hubspotResults([{ id: "m2cc", firstName: "Cody", phone: "+1 555 644 9001" }]);
  const summary = await pull();
  assert.equal(summary.matched, 1);
  assert.equal(summary.unmatched, 0);
  assert.equal((await leadRow(leadId)).first_name, "Cody");
});

test("matches by external_record_id when email and phone are both missing", async () => {
  const leadId = await insertLead({ externalRecordId: "hubspot:ext77" });
  hubspotResults([{ id: "ext77", lastName: "Rivera" }]);
  const summary = await pull();
  assert.equal(summary.matched, 1);
  assert.equal((await leadRow(leadId)).last_name, "Rivera");
});

test("remote contacts with no matching lead are counted, never inserted", async () => {
  hubspotResults([{ id: "nomatch", firstName: "Ghost", email: "ghost@nowhere.com" }]);
  const summary = await pull();
  assert.deepEqual([summary.matched, summary.updated, summary.conflicts, summary.unmatched], [0, 0, 0, 1]);
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM rescue_leads WHERE organization_id = $1`, [state.orgId]);
  assert.equal(rows[0].n, 0);
});

// ---- conflict routing (no silent overwrite) ----------------------------------

test("disagreement without a provably-newer remote records a conflict and leaves the lead untouched", async () => {
  const localUpdated = new Date().toISOString();
  const leadId = await insertLead({
    firstName: "Local",
    lastName: "Truth",
    email: "conflict@example.com",
    emailNormalized: "conflict@example.com",
    updatedAt: localUpdated,
  });
  // Remote has no updatedAt at all — it can never be provably newer.
  hubspotResults([{ id: "c1", firstName: "Remote", lastName: "Claim", email: "conflict@example.com" }]);
  const summary = await pull();
  assert.equal(summary.conflicts, 1);
  assert.equal(summary.updated, 0);

  const lead = await leadRow(leadId);
  assert.equal(lead.first_name, "Local");
  assert.equal(lead.last_name, "Truth");

  const conflicts = await conflictsFor(leadId);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].status, "pending");
  assert.equal(conflicts[0].source, "crm_pull:hubspot");
  assert.equal(String(conflicts[0].connection_id), state.connId);
  assert.deepEqual(conflicts[0].fields, [
    { field: "firstName", localValue: "Local", remoteValue: "Remote" },
    { field: "lastName", localValue: "Truth", remoteValue: "Claim" },
  ]);
  assert.equal(conflicts[0].remote_updated_at, null);
});

test("remote older than local records a conflict instead of overwriting the newer local edit", async () => {
  const leadId = await insertLead({
    firstName: "Newer",
    email: "older-remote@example.com",
    emailNormalized: "older-remote@example.com",
    updatedAt: "2026-08-03T12:00:00Z",
  });
  hubspotResults([{ id: "c2", firstName: "Stale", email: "older-remote@example.com", updatedAt: "2026-08-01T00:00:00Z" }]);
  const summary = await pull();
  assert.equal(summary.conflicts, 1);
  assert.equal(summary.updated, 0);
  assert.equal((await leadRow(leadId)).first_name, "Newer");
  const [conflict] = await conflictsFor(leadId);
  assert.equal(new Date(conflict.remote_updated_at).toISOString(), "2026-08-01T00:00:00.000Z");
  assert.equal(new Date(conflict.local_updated_at).toISOString(), "2026-08-03T12:00:00.000Z");
});

test("unparsable remote timestamp is treated as not-provably-newer (conflict, not overwrite)", async () => {
  const leadId = await insertLead({
    firstName: "Keep",
    email: "badts@example.com",
    emailNormalized: "badts@example.com",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  hubspotResults([{ id: "c3", firstName: "Discard", email: "badts@example.com", updatedAt: "not-a-date" }]);
  const summary = await pull();
  assert.equal(summary.conflicts, 1);
  assert.equal((await leadRow(leadId)).first_name, "Keep");
});

// ---- auto-apply rules ---------------------------------------------------------

test("provably-newer remote auto-applies and bumps updated_at, with no conflict row", async () => {
  const leadId = await insertLead({
    firstName: "Old",
    lastName: "Name",
    email: "newer-remote@example.com",
    emailNormalized: "newer-remote@example.com",
    updatedAt: "2026-08-01T00:00:00Z",
  });
  hubspotResults([{ id: "a1", firstName: "New", lastName: "Name", email: "newer-remote@example.com", updatedAt: "2026-08-03T00:00:00Z" }]);
  const summary = await pull();
  assert.equal(summary.updated, 1);
  assert.equal(summary.conflicts, 0);
  const lead = await leadRow(leadId);
  assert.equal(lead.first_name, "New");
  assert.equal(lead.last_name, "Name");
  assert.ok(new Date(lead.updated_at).getTime() > Date.parse("2026-08-03T00:00:00Z"));
  assert.equal((await conflictsFor(leadId)).length, 0);
});

test("filling empty local fields is an update, not a conflict, even without a remote timestamp", async () => {
  const leadId = await insertLead({ email: "blank@example.com", emailNormalized: "blank@example.com" });
  hubspotResults([{ id: "a2", firstName: "Filled", lastName: "In", email: "blank@example.com" }]);
  const summary = await pull();
  assert.equal(summary.updated, 1);
  assert.equal(summary.conflicts, 0);
  const lead = await leadRow(leadId);
  assert.equal(lead.first_name, "Filled");
  assert.equal(lead.last_name, "In");
});

test("identical local and remote values are a no-op: matched but neither updated nor conflicted", async () => {
  await insertLead({ firstName: "Same", lastName: "Same", email: "same@example.com", emailNormalized: "same@example.com" });
  hubspotResults([{ id: "a3", firstName: "Same", lastName: "Same", email: "same@example.com" }]);
  const summary = await pull();
  assert.deepEqual([summary.matched, summary.updated, summary.conflicts], [1, 0, 0]);
});

// ---- blank remote fields never null out local data ----------------------------

test("missing/blank remote fields never null out existing local values", async () => {
  const leadId = await insertLead({
    firstName: "Keep",
    lastName: "Both",
    email: "sparse@example.com",
    emailNormalized: "sparse@example.com",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  // Remote is provably newer but sends firstName: "" and no lastName — neither
  // may clear local data, and with no real change there is nothing to update.
  hubspotResults([{ id: "b1", firstName: "", email: "sparse@example.com", updatedAt: "2026-08-03T00:00:00Z" }]);
  const summary = await pull();
  assert.deepEqual([summary.matched, summary.updated, summary.conflicts], [1, 0, 0]);
  const lead = await leadRow(leadId);
  assert.equal(lead.first_name, "Keep");
  assert.equal(lead.last_name, "Both");
});

test("blank remote fields are ignored while real changes still apply when remote is newer", async () => {
  const leadId = await insertLead({
    firstName: "Old",
    lastName: "Keep",
    email: "partial@example.com",
    emailNormalized: "partial@example.com",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  hubspotResults([{ id: "b2", firstName: "New", lastName: "", email: "partial@example.com", updatedAt: "2026-08-03T00:00:00Z" }]);
  const summary = await pull();
  assert.equal(summary.updated, 1);
  const lead = await leadRow(leadId);
  assert.equal(lead.first_name, "New");
  assert.equal(lead.last_name, "Keep"); // blank remote value never clears local data
});

// ---- summary bookkeeping -------------------------------------------------------

test("successful pull records lastPull on the connection and resets consecutiveFailures", async () => {
  hubspotResults([]);
  const summary = await pull();
  assert.equal(summary.ok, true);
  assert.equal(summary.consecutiveFailures, 0);
  const conn = await getCrmConnection(state.orgId, state.connId);
  assert.equal(conn.lastTestResult.lastPull.ok, true);
  assert.ok(conn.lastTestResult.lastPull.at);
});
