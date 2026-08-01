/**
 * Integration tests for the reports, team, and settings dashboard APIs:
 * role gating (owner/admin vs read-only analyst), tenant isolation,
 * entitlement enforcement for reports, suppression-list behavior, and
 * audit-log writes for every mutation.
 *
 * Runs against the live dev server (default http://127.0.0.1:5000) over real
 * HTTP. Requires DATABASE_URL and ADMIN_PASSWORD in the env.
 *
 *   npm test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const BASE = process.env.TEST_BASE_URL ?? "http://127.0.0.1:5000";
const RUN = `tsr${Date.now().toString(36)}`;
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
  const contentType = response.headers.get("content-type") ?? "";
  let json = null;
  let text = null;
  if (contentType.includes("application/json")) {
    json = await response.json().catch(() => null);
  } else {
    text = await response.text().catch(() => null);
  }
  return { status: response.status, json, text, cookie: sessionCookie, headers: response.headers };
}

async function auditRows(orgId, action) {
  const { rows } = await db.query(
    "SELECT * FROM audit_logs WHERE organization_id = $1 AND action = $2 ORDER BY created_at DESC",
    [orgId, action],
  );
  return rows;
}

async function cleanup() {
  await db.query("DELETE FROM organizations WHERE slug LIKE 'test-tsr%'");
  await db.query("DELETE FROM users WHERE email LIKE '%@tsr-test.local'");
}

const state = {};

before(async () => {
  await db.connect();
  await cleanup();

  const adminLogin = await request("/api/admin/session", { method: "POST", body: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(adminLogin.status, 200, "admin login should succeed");

  // Org A: full modules incl. analytics. Org B: revenue_rescue only (no analytics).
  const provisionA = await request("/api/admin/organizations", {
    method: "POST",
    cookie: adminLogin.cookie,
    body: {
      name: `Test ${RUN} Org A`,
      slug: `test-${RUN}-a`,
      plan: "scale",
      modules: ["revenue_rescue", "lead_import", "analytics"],
      usageLimits: { seats: 5 },
      allowedOrigins: [],
      owner: { email: `owner-a-${RUN}@tsr-test.local`, name: "Owner A" },
    },
  });
  assert.equal(provisionA.status, 201, `provision A: ${JSON.stringify(provisionA.json)}`);
  state.orgA = provisionA.json.organizationId;

  const provisionB = await request("/api/admin/organizations", {
    method: "POST",
    cookie: adminLogin.cookie,
    body: {
      name: `Test ${RUN} Org B`,
      slug: `test-${RUN}-b`,
      plan: "starter",
      modules: ["revenue_rescue"],
      usageLimits: { seats: 2 },
      allowedOrigins: [],
      owner: { email: `owner-b-${RUN}@tsr-test.local`, name: "Owner B" },
    },
  });
  assert.equal(provisionB.status, 201);
  state.orgB = provisionB.json.organizationId;

  const acceptA = await request("/api/invites/accept", {
    method: "POST",
    body: { token: provisionA.json.inviteToken, name: "Owner A", password: "password-a-123" },
  });
  assert.equal(acceptA.status, 200);
  state.ownerACookie = acceptA.cookie;

  const acceptB = await request("/api/invites/accept", {
    method: "POST",
    body: { token: provisionB.json.inviteToken, name: "Owner B", password: "password-b-123" },
  });
  assert.equal(acceptB.status, 200);
  state.ownerBCookie = acceptB.cookie;

  // Read-only analyst in org A.
  const analystInvite = await request(`/api/orgs/${state.orgA}/members`, {
    method: "POST",
    cookie: state.ownerACookie,
    body: { email: `analyst-${RUN}@tsr-test.local`, role: "read_only_analyst" },
  });
  assert.equal(analystInvite.status, 201);
  const analystAccept = await request("/api/invites/accept", {
    method: "POST",
    body: { token: analystInvite.json.invite.token, name: "Analyst", password: "password-an-123" },
  });
  assert.equal(analystAccept.status, 200);
  state.analystCookie = analystAccept.cookie;
});

after(async () => {
  await cleanup();
  await db.end();
});

// ---------- Reports ----------

test("reports require membership and the analytics entitlement", async () => {
  const anonymous = await request(`/api/orgs/${state.orgA}/reports`);
  assert.equal(anonymous.status, 401);

  const crossTenant = await request(`/api/orgs/${state.orgA}/reports`, { cookie: state.ownerBCookie });
  assert.equal(crossTenant.status, 403);

  // Org B has no analytics module.
  const noEntitlement = await request(`/api/orgs/${state.orgB}/reports`, { cookie: state.ownerBCookie });
  assert.equal(noEntitlement.status, 403);
  assert.equal(noEntitlement.json.code, "entitlement_required");
});

test("reports return honest zeros for an empty org", async () => {
  const res = await request(`/api/orgs/${state.orgA}/reports?from=2026-01-01&to=2026-12-31`, { cookie: state.ownerACookie });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const { metrics } = res.json;
  assert.equal(metrics.summary.leadsAdded, 0);
  assert.equal(metrics.summary.recoveredPipeline, 0);
  assert.equal(metrics.summary.replyRate, null, "no fabricated rates without contacts");
  assert.deepEqual(metrics.campaigns, []);
  assert.deepEqual(metrics.sources, []);
  assert.equal(metrics.range.from, "2026-01-01");
  // Malformed dates are treated as unbounded, not errors.
  const badDates = await request(`/api/orgs/${state.orgA}/reports?from=13/01/2026`, { cookie: state.ownerACookie });
  assert.equal(badDates.status, 200);
  assert.equal(badDates.json.metrics.range.from, null);
});

test("report CSV export returns the underlying rows and audits the export", async () => {
  // Seed one lead so the export has a row.
  await db.query(
    `INSERT INTO rescue_leads (organization_id, first_name, last_name, email, email_normalized, source, estimated_value)
     VALUES ($1, 'Casey', 'Roof', $2, $2, 'Angi', 12000)`,
    [state.orgA, `casey-${RUN}@tsr-test.local`],
  );
  const res = await request(`/api/orgs/${state.orgA}/reports/export`, { cookie: state.ownerACookie });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  const lines = res.text.trim().split("\n");
  assert.match(lines[0], /^lead_id,first_name/);
  assert.equal(lines.length, 2, "header + one lead row");
  assert.match(lines[1], /Casey/);

  const audits = await auditRows(state.orgA, "report.exported");
  assert.ok(audits.length >= 1, "export writes an audit entry");

  // The analyst (viewer) can also export — reads are open to members.
  const analystExport = await request(`/api/orgs/${state.orgA}/reports/export`, { cookie: state.analystCookie });
  assert.equal(analystExport.status, 200);

  const outsiderExport = await request(`/api/orgs/${state.orgA}/reports/export`, { cookie: state.ownerBCookie });
  assert.equal(outsiderExport.status, 403);
});

// ---------- Team: invites ----------

test("invite listing is manager-only and shows statuses", async () => {
  const analystList = await request(`/api/orgs/${state.orgA}/invites`, { cookie: state.analystCookie });
  assert.equal(analystList.status, 403);

  const ownerList = await request(`/api/orgs/${state.orgA}/invites`, { cookie: state.ownerACookie });
  assert.equal(ownerList.status, 200);
  const accepted = ownerList.json.invites.find((i) => i.status === "accepted");
  assert.ok(accepted, "the analyst's accepted invite is listed as accepted");
  assert.equal(accepted.token, null, "accepted invites do not expose tokens");
});

test("pending invites can be revoked (manager-only) and revocation is audited", async () => {
  const created = await request(`/api/orgs/${state.orgA}/members`, {
    method: "POST",
    cookie: state.ownerACookie,
    body: { email: `pending-${RUN}@tsr-test.local`, role: "office_staff" },
  });
  assert.equal(created.status, 201);
  const inviteId = created.json.invite.id;
  const token = created.json.invite.token;

  const listed = await request(`/api/orgs/${state.orgA}/invites`, { cookie: state.ownerACookie });
  const pending = listed.json.invites.find((i) => i.id === inviteId);
  assert.equal(pending.status, "pending");
  assert.equal(pending.token, token, "pending invites expose their link token to managers");

  const analystRevoke = await request(`/api/orgs/${state.orgA}/invites/${inviteId}`, { method: "DELETE", cookie: state.analystCookie });
  assert.equal(analystRevoke.status, 403);
  const crossRevoke = await request(`/api/orgs/${state.orgB}/invites/${inviteId}`, { method: "DELETE", cookie: state.ownerBCookie });
  assert.equal(crossRevoke.status, 404, "invite ids are scoped to their org");

  const revoke = await request(`/api/orgs/${state.orgA}/invites/${inviteId}`, { method: "DELETE", cookie: state.ownerACookie });
  assert.equal(revoke.status, 200);

  // The revoked token is dead.
  const accept = await request("/api/invites/accept", {
    method: "POST",
    body: { token, name: "Too Late", password: "password-late-123" },
  });
  assert.notEqual(accept.status, 200);

  const audits = await auditRows(state.orgA, "member.invite_revoked");
  assert.ok(audits.length >= 1, "revocation writes an audit entry");
});

// ---------- Settings ----------

test("settings read is member-wide; writes are owner/admin only and audited", async () => {
  const analystRead = await request(`/api/orgs/${state.orgA}/settings`, { cookie: state.analystCookie });
  assert.equal(analystRead.status, 200);
  assert.equal(analystRead.json.canManage, false);
  assert.equal(analystRead.json.settings.messaging.quietHoursStart, 20, "defaults are returned");

  const analystWrite = await request(`/api/orgs/${state.orgA}/settings`, {
    method: "PATCH",
    cookie: state.analystCookie,
    body: { messaging: { quietHoursStart: 22 } },
  });
  assert.equal(analystWrite.status, 403);

  const badTimezone = await request(`/api/orgs/${state.orgA}/settings`, {
    method: "PATCH",
    cookie: state.ownerACookie,
    body: { profile: { timezone: "Mars/Olympus_Mons" } },
  });
  assert.equal(badTimezone.status, 400);

  const write = await request(`/api/orgs/${state.orgA}/settings`, {
    method: "PATCH",
    cookie: state.ownerACookie,
    body: {
      profile: { timezone: "America/Chicago" },
      contact: { contactEmail: `ops-${RUN}@tsr-test.local` },
      messaging: { quietHoursStart: 21, defaultTone: "friendly" },
      notifications: { weeklyDigest: true, notificationEmails: [`alerts-${RUN}@tsr-test.local`, "not-an-email"] },
    },
  });
  assert.equal(write.status, 200, JSON.stringify(write.json));
  assert.equal(write.json.organization.timezone, "America/Chicago");
  assert.equal(write.json.settings.messaging.quietHoursStart, 21);
  assert.deepEqual(write.json.settings.notifications.notificationEmails, [`alerts-${RUN}@tsr-test.local`]);

  // Persisted, and partial patches leave other sections alone.
  const reread = await request(`/api/orgs/${state.orgA}/settings`, { cookie: state.ownerACookie });
  assert.equal(reread.json.settings.messaging.defaultTone, "friendly");
  assert.equal(reread.json.settings.contact.contactEmail, `ops-${RUN}@tsr-test.local`);
  assert.equal(reread.json.settings.notifications.weeklyDigest, true);

  const audits = await auditRows(state.orgA, "org.settings_updated");
  assert.ok(audits.length >= 1, "settings changes write an audit entry");
  assert.ok(audits[0].metadata.sections.includes("messaging"));
});

// ---------- Suppression list ----------

test("suppression add/remove is owner/admin only, suppresses matching leads, and is audited", async () => {
  const target = `blockme-${RUN}@tsr-test.local`;
  await db.query(
    `INSERT INTO rescue_leads (organization_id, first_name, email, email_normalized) VALUES ($1, 'Blocked', $2, $2)`,
    [state.orgA, target],
  );

  const analystAdd = await request(`/api/orgs/${state.orgA}/suppressions`, {
    method: "POST",
    cookie: state.analystCookie,
    body: { channel: "email", value: target },
  });
  assert.equal(analystAdd.status, 403);

  const invalid = await request(`/api/orgs/${state.orgA}/suppressions`, {
    method: "POST",
    cookie: state.ownerACookie,
    body: { channel: "email", value: "not-an-email" },
  });
  assert.equal(invalid.status, 400);

  const add = await request(`/api/orgs/${state.orgA}/suppressions`, {
    method: "POST",
    cookie: state.ownerACookie,
    body: { channel: "email", value: ` ${target.toUpperCase()} `, note: "test block" },
  });
  assert.equal(add.status, 201, JSON.stringify(add.json));
  assert.equal(add.json.record.value, target, "values are normalized before storing");
  assert.equal(add.json.leadsSuppressed, 1, "the matching lead was suppressed");

  const { rows: leads } = await db.query(
    "SELECT suppressed, pipeline_stage FROM rescue_leads WHERE organization_id = $1 AND email_normalized = $2",
    [state.orgA, target],
  );
  assert.equal(leads[0].suppressed, true);
  assert.equal(leads[0].pipeline_stage, "suppressed");

  const duplicate = await request(`/api/orgs/${state.orgA}/suppressions`, {
    method: "POST",
    cookie: state.ownerACookie,
    body: { channel: "email", value: target },
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.json.alreadyListed, true);

  // Any member can view the list; the analyst sees it read-only.
  const analystView = await request(`/api/orgs/${state.orgA}/suppressions`, { cookie: state.analystCookie });
  assert.equal(analystView.status, 200);
  assert.equal(analystView.json.canManage, false);
  const entry = analystView.json.suppressions.find((s) => s.value === target);
  assert.ok(entry);

  const crossRemove = await request(`/api/orgs/${state.orgB}/suppressions/${entry.id}`, { method: "DELETE", cookie: state.ownerBCookie });
  assert.equal(crossRemove.status, 404, "suppression ids are scoped to their org");
  const analystRemove = await request(`/api/orgs/${state.orgA}/suppressions/${entry.id}`, { method: "DELETE", cookie: state.analystCookie });
  assert.equal(analystRemove.status, 403);

  const remove = await request(`/api/orgs/${state.orgA}/suppressions/${entry.id}`, { method: "DELETE", cookie: state.ownerACookie });
  assert.equal(remove.status, 200);

  const added = await auditRows(state.orgA, "suppression.added");
  const removed = await auditRows(state.orgA, "suppression.removed");
  assert.ok(added.length >= 1, "adding writes an audit entry");
  assert.ok(removed.length >= 1, "removing writes an audit entry");
});

// ---------- Phone suppression normalization ----------

test("phone suppressions normalize to E.164", async () => {
  const add = await request(`/api/orgs/${state.orgA}/suppressions`, {
    method: "POST",
    cookie: state.ownerACookie,
    body: { channel: "phone", value: "(555) 010-4242" },
  });
  assert.equal(add.status, 201);
  assert.equal(add.json.record.value, "+15550104242");

  const bad = await request(`/api/orgs/${state.orgA}/suppressions`, {
    method: "POST",
    cookie: state.ownerACookie,
    body: { channel: "phone", value: "12345" },
  });
  assert.equal(bad.status, 400);
});
