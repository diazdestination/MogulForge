/**
 * Tenant-isolation & authorization tests.
 *
 * Runs against the live dev server (default http://127.0.0.1:5000) over real HTTP,
 * exercising the actual auth cookies, membership checks, role checks, and
 * entitlement enforcement. Requires DATABASE_URL and ADMIN_PASSWORD in the env.
 *
 *   npm test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const BASE = process.env.TEST_BASE_URL ?? "http://127.0.0.1:5000";
const RUN = `iso${Date.now().toString(36)}`;
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
  let json = null;
  try {
    json = await response.json();
  } catch {
    /* non-JSON response */
  }
  return { status: response.status, json, cookie: sessionCookie };
}

async function cleanup() {
  await db.query("DELETE FROM organizations WHERE slug LIKE $1", [`test-${RUN}%`]);
  await db.query("DELETE FROM organizations WHERE slug LIKE 'test-iso%'");
  await db.query("DELETE FROM users WHERE email LIKE '%@iso-test.local'");
}

// Shared state built up in setup
const state = {};

before(async () => {
  await db.connect();
  await cleanup();

  // Platform admin session via the ADMIN_PASSWORD (legacy admin folded into platform admin)
  assert.ok(process.env.ADMIN_PASSWORD, "ADMIN_PASSWORD must be set for tests");
  const adminLogin = await request("/api/admin/session", { method: "POST", body: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(adminLogin.status, 200, "admin login should succeed");
  state.adminCookie = adminLogin.cookie;

  // Provision two orgs: A has sms_campaigns enabled, B does not.
  const provisionA = await request("/api/admin/organizations", {
    method: "POST",
    cookie: state.adminCookie,
    body: {
      name: `Test ${RUN} Org A`,
      slug: `test-${RUN}-a`,
      plan: "scale",
      modules: ["revenue_rescue", "lead_import", "sms_campaigns"],
      usageLimits: { seats: 5 },
      allowedOrigins: ["https://a.example.com"],
      owner: { email: `owner-a-${RUN}@iso-test.local`, name: "Owner A" },
    },
  });
  assert.equal(provisionA.status, 201, `provision A: ${JSON.stringify(provisionA.json)}`);
  state.orgA = provisionA.json.organizationId;

  const provisionB = await request("/api/admin/organizations", {
    method: "POST",
    cookie: state.adminCookie,
    body: {
      name: `Test ${RUN} Org B`,
      slug: `test-${RUN}-b`,
      plan: "starter",
      modules: ["revenue_rescue"],
      usageLimits: { seats: 2 },
      allowedOrigins: [],
      owner: { email: `owner-b-${RUN}@iso-test.local`, name: "Owner B" },
    },
  });
  assert.equal(provisionB.status, 201, `provision B: ${JSON.stringify(provisionB.json)}`);
  state.orgB = provisionB.json.organizationId;

  // Owners accept their invites (creates accounts + sessions)
  const acceptA = await request("/api/invites/accept", {
    method: "POST",
    body: { token: provisionA.json.inviteToken, name: "Owner A", password: "password-a-123" },
  });
  assert.equal(acceptA.status, 200, `accept A: ${JSON.stringify(acceptA.json)}`);
  state.ownerACookie = acceptA.cookie;
  state.inviteTokenA = provisionA.json.inviteToken;

  const acceptB = await request("/api/invites/accept", {
    method: "POST",
    body: { token: provisionB.json.inviteToken, name: "Owner B", password: "password-b-123" },
  });
  assert.equal(acceptB.status, 200, `accept B: ${JSON.stringify(acceptB.json)}`);
  state.ownerBCookie = acceptB.cookie;

  // Owner A invites a read-only analyst into org A; analyst accepts.
  const analystInvite = await request(`/api/orgs/${state.orgA}/members`, {
    method: "POST",
    cookie: state.ownerACookie,
    body: { email: `analyst-${RUN}@iso-test.local`, role: "read_only_analyst" },
  });
  assert.equal(analystInvite.status, 201, `analyst invite: ${JSON.stringify(analystInvite.json)}`);
  const analystAccept = await request("/api/invites/accept", {
    method: "POST",
    body: { token: analystInvite.json.invite.token, name: "Analyst", password: "password-an-123" },
  });
  assert.equal(analystAccept.status, 200);
  state.analystCookie = analystAccept.cookie;

  // A user with no org memberships at all.
  const outsider = await request("/api/auth/register", {
    method: "POST",
    body: { email: `outsider-${RUN}@iso-test.local`, name: "Outsider", password: "password-out-123" },
  });
  assert.equal(outsider.status, 201);
  state.outsiderCookie = outsider.cookie;

  // Grab membership ids for cross-org write attempts.
  const membersB = await request(`/api/orgs/${state.orgB}/members`, { cookie: state.ownerBCookie });
  assert.equal(membersB.status, 200);
  state.ownerBMembershipId = membersB.json.members[0].membershipId;
  const membersA = await request(`/api/orgs/${state.orgA}/members`, { cookie: state.ownerACookie });
  state.analystMembershipId = membersA.json.members.find((m) => m.role === "read_only_analyst").membershipId;
});

after(async () => {
  await cleanup();
  await db.end();
});

// ---------- Authentication ----------

test("unauthenticated requests get 401 on tenant routes", async () => {
  for (const path of [`/api/orgs/${state.orgA}`, `/api/orgs/${state.orgA}/members`, `/api/orgs/${state.orgA}/entitlements`, `/api/orgs/${state.orgA}/features/revenue_rescue`, "/api/auth/me"]) {
    const res = await request(path);
    assert.equal(res.status, 401, `${path} should be 401`);
  }
});

test("members can read their own org", async () => {
  const org = await request(`/api/orgs/${state.orgA}`, { cookie: state.ownerACookie });
  assert.equal(org.status, 200);
  assert.equal(org.json.organization.id, state.orgA);
  assert.equal(org.json.role, "owner");
});

// ---------- Cross-tenant isolation (reads) ----------

test("org A owner cannot READ any of org B's resources", async () => {
  for (const path of [`/api/orgs/${state.orgB}`, `/api/orgs/${state.orgB}/members`, `/api/orgs/${state.orgB}/entitlements`, `/api/orgs/${state.orgB}/features/revenue_rescue`]) {
    const res = await request(path, { cookie: state.ownerACookie });
    assert.equal(res.status, 403, `${path} should be 403 for org A owner`);
    assert.ok(res.json.error, "error message should be present");
  }
});

test("user with no memberships cannot read either org", async () => {
  for (const orgId of [state.orgA, state.orgB]) {
    const res = await request(`/api/orgs/${orgId}`, { cookie: state.outsiderCookie });
    assert.equal(res.status, 403);
  }
});

// ---------- Cross-tenant isolation (writes) ----------

test("org A owner cannot WRITE to org B", async () => {
  const patch = await request(`/api/orgs/${state.orgB}`, { method: "PATCH", cookie: state.ownerACookie, body: { name: "Hacked" } });
  assert.equal(patch.status, 403);

  const invite = await request(`/api/orgs/${state.orgB}/members`, { method: "POST", cookie: state.ownerACookie, body: { email: `evil-${RUN}@iso-test.local`, role: "admin" } });
  assert.equal(invite.status, 403);

  const roleChange = await request(`/api/orgs/${state.orgB}/members/${state.ownerBMembershipId}`, { method: "PATCH", cookie: state.ownerACookie, body: { role: "office_staff" } });
  assert.equal(roleChange.status, 403);

  const remove = await request(`/api/orgs/${state.orgB}/members/${state.ownerBMembershipId}`, { method: "DELETE", cookie: state.ownerACookie });
  assert.equal(remove.status, 403);

  // Verify org B is untouched
  const orgB = await request(`/api/orgs/${state.orgB}`, { cookie: state.ownerBCookie });
  assert.equal(orgB.status, 200);
  assert.notEqual(orgB.json.organization.name, "Hacked");
});

test("membership ids from another org cannot be manipulated even via your own org's URL", async () => {
  // Org-scoped query: org B's membership id does not exist inside org A → 404, no write.
  const res = await request(`/api/orgs/${state.orgA}/members/${state.ownerBMembershipId}`, { method: "PATCH", cookie: state.ownerACookie, body: { role: "office_staff" } });
  assert.equal(res.status, 404);
  const membersB = await request(`/api/orgs/${state.orgB}/members`, { cookie: state.ownerBCookie });
  assert.equal(membersB.json.members[0].role, "owner", "org B owner role must be unchanged");
});

// ---------- Role enforcement ----------

test("read-only analyst can read but not write", async () => {
  const members = await request(`/api/orgs/${state.orgA}/members`, { cookie: state.analystCookie });
  assert.equal(members.status, 200);

  const patch = await request(`/api/orgs/${state.orgA}`, { method: "PATCH", cookie: state.analystCookie, body: { name: "Analyst Rename" } });
  assert.equal(patch.status, 403);
  assert.equal(patch.json.code, "forbidden_role");

  const invite = await request(`/api/orgs/${state.orgA}/members`, { method: "POST", cookie: state.analystCookie, body: { email: `friend-${RUN}@iso-test.local`, role: "admin" } });
  assert.equal(invite.status, 403);

  const roleChange = await request(`/api/orgs/${state.orgA}/members/${state.analystMembershipId}`, { method: "PATCH", cookie: state.analystCookie, body: { role: "admin" } });
  assert.equal(roleChange.status, 403, "analyst must not self-promote");
});

// ---------- Entitlement enforcement ----------

test("disabled module returns a clear 403 (entitlement_required)", async () => {
  const denied = await request(`/api/orgs/${state.orgB}/features/sms_campaigns`, { cookie: state.ownerBCookie });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.code, "entitlement_required");
  assert.match(denied.json.error, /not enabled/i);
});

test("enabled modules return 200 for members", async () => {
  const smsA = await request(`/api/orgs/${state.orgA}/features/sms_campaigns`, { cookie: state.ownerACookie });
  assert.equal(smsA.status, 200);
  const rescueB = await request(`/api/orgs/${state.orgB}/features/revenue_rescue`, { cookie: state.ownerBCookie });
  assert.equal(rescueB.status, 200);
});

// ---------- Platform admin boundary ----------

test("regular users cannot access platform-admin APIs", async () => {
  const asOwner = await request("/api/admin/organizations", { cookie: state.ownerACookie });
  assert.equal(asOwner.status, 403);
  const unauthed = await request("/api/admin/organizations");
  assert.equal(unauthed.status, 401);
  const detail = await request(`/api/admin/organizations/${state.orgB}`, { cookie: state.ownerACookie });
  assert.equal(detail.status, 403);
});

test("platform admin can read both orgs", async () => {
  for (const orgId of [state.orgA, state.orgB]) {
    const res = await request(`/api/admin/organizations/${orgId}`, { cookie: state.adminCookie });
    assert.equal(res.status, 200);
    assert.equal(res.json.organization.id, orgId);
  }
});

// ---------- Invites & sessions ----------

test("an invite token cannot be reused", async () => {
  const res = await request("/api/invites/accept", { method: "POST", body: { token: state.inviteTokenA, name: "Again", password: "password-a-123" } });
  assert.equal(res.status, 400);
});

test("wrong password is rejected", async () => {
  const res = await request("/api/auth/login", { method: "POST", body: { email: `owner-a-${RUN}@iso-test.local`, password: "wrong-password" } });
  assert.equal(res.status, 401);
});

test("tampered session cookies are rejected", async () => {
  const forged = state.ownerACookie.replace(/mf_session=([^;]+)/, (m, v) => `mf_session=${v.slice(0, -4)}AAAA`);
  const res = await request(`/api/orgs/${state.orgA}`, { cookie: forged });
  assert.equal(res.status, 401);
});
