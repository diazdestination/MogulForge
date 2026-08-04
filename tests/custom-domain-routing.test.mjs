/**
 * Custom-domain live routing integration tests.
 *
 * Runs against the live dev server over real HTTP, sending spoofed Host /
 * X-Forwarded-Host headers (via node:http — fetch strips the Host header):
 *   - "/" on an active custom domain routes to the owning org's portal login
 *   - the login page renders the org's branded login (title, powered-by)
 *   - unknown / removed / verified-but-not-activated domains never route
 *   - the dashboard pins the org to the domain owner (non-members get no org)
 *   - the first HTTPS request flips ssl_status pending → issued (honest SSL)
 *
 * Requires DATABASE_URL and ADMIN_PASSWORD in the env.  npm test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import pg from "pg";

const BASE = new URL(process.env.TEST_BASE_URL ?? "http://127.0.0.1:5000");
const RUN = `cd${Date.now().toString(36)}`;
const DOMAIN = `portal.test-${RUN}.example.com`;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

/** GET with an arbitrary Host header (undici fetch forbids setting Host). */
function hostGet(path, host, { cookie, proto } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: BASE.hostname,
        port: BASE.port || 80,
        path,
        method: "GET",
        headers: {
          Host: host,
          "X-Forwarded-Host": host,
          ...(proto ? { "X-Forwarded-Proto": proto } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location ?? null, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function api(path, { method = "GET", body, cookie } = {}) {
  const response = await fetch(`${BASE.origin}${path}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  return {
    status: response.status,
    json: await response.json().catch(() => null),
    cookie: setCookie.map((c) => c.split(";")[0]).join("; ") || null,
  };
}

const state = {};

async function cleanup() {
  await db.query("DELETE FROM organizations WHERE slug LIKE 'test-cd%'");
  await db.query("DELETE FROM users WHERE email LIKE '%@cd-routing-test.local'");
}

before(async () => {
  await db.connect();
  await cleanup();

  const adminLogin = await api("/api/admin/session", { method: "POST", body: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(adminLogin.status, 200);

  const provision = await api("/api/admin/organizations", {
    method: "POST",
    cookie: adminLogin.cookie,
    body: {
      name: `Test ${RUN} Domains`,
      slug: `test-${RUN}`,
      plan: "growth",
      modules: ["revenue_rescue", "lead_import", "white_label"],
      owner: { email: `owner-${RUN}@cd-routing-test.local`, name: "Owner" },
    },
  });
  assert.equal(provision.status, 201, JSON.stringify(provision.json));
  state.org = provision.json.organizationId;

  const accept = await api("/api/invites/accept", {
    method: "POST",
    body: { token: provision.json.inviteToken, name: "Owner", password: "password-cd-123" },
  });
  assert.equal(accept.status, 200);
  state.owner = accept.cookie;

  const outsider = await api("/api/auth/register", {
    method: "POST",
    body: { email: `outsider-${RUN}@cd-routing-test.local`, name: "Outsider", password: "password-cd-456" },
  });
  assert.equal(outsider.status, 201);
  state.outsider = outsider.cookie;

  // Branded login content to assert on.
  const branding = await api(`/api/orgs/${state.org}/branding`, {
    method: "PATCH",
    cookie: state.owner,
    body: { brandingLevel: "powered_by", displayName: `Acme ${RUN}`, loginTitle: `Welcome back to Acme ${RUN}` },
  });
  assert.equal(branding.status, 200, JSON.stringify(branding.json));

  // Request the domain through the real API, then simulate verify + activate.
  const request = await api(`/api/orgs/${state.org}/domains`, { method: "POST", cookie: state.owner, body: { domain: DOMAIN } });
  assert.equal(request.status, 201, JSON.stringify(request.json));
  state.domainId = request.json.domain.id;
});

after(async () => {
  await cleanup();
  await db.end();
});

test("verified-but-not-activated domains never route", async () => {
  await db.query("UPDATE custom_domains SET status = 'verified', verified_at = now() WHERE id = $1", [state.domainId]);
  const res = await hostGet("/", DOMAIN);
  assert.equal(res.status, 200);
  assert.match(res.body, /isn(?:&#x27;|&apos;|')t serving a portal yet/);
});

test("active domain routes '/' to the org's portal login", async () => {
  await db.query("UPDATE custom_domains SET status = 'active', ssl_status = 'pending', activated_at = now() WHERE id = $1", [state.domainId]);
  const res = await hostGet("/", DOMAIN);
  assert.ok([302, 303, 307, 308].includes(res.status), `expected redirect, got ${res.status}`);
  assert.ok(res.location?.includes("/login"), res.location ?? "no location");
});

test("login page renders the org's branded login on its domain", async () => {
  const res = await hostGet("/login", DOMAIN);
  assert.equal(res.status, 200);
  assert.match(res.body, new RegExp(`Welcome back to Acme ${RUN}`));
  assert.match(res.body, /Powered by MogulForge/);
  assert.doesNotMatch(res.body, /Create one/); // self-signup hidden on client portals
});

test("first HTTPS request flips ssl_status pending → issued", async () => {
  const { rows: beforeRows } = await db.query("SELECT ssl_status FROM custom_domains WHERE id = $1", [state.domainId]);
  assert.equal(beforeRows[0].ssl_status, "pending");
  const res = await hostGet("/login", DOMAIN, { proto: "https" });
  assert.equal(res.status, 200);
  const { rows } = await db.query("SELECT ssl_status FROM custom_domains WHERE id = $1", [state.domainId]);
  assert.equal(rows[0].ssl_status, "issued");
});

test("dashboard on a portal domain is pinned to the owning org", async () => {
  const owner = await hostGet("/dashboard/revenue-rescue", DOMAIN, { cookie: state.owner });
  assert.equal(owner.status, 200);
  assert.match(owner.body, new RegExp(`Test ${RUN} Domains`));

  // A signed-in user who is not a member of the owning org gets no workspace —
  // their other-org memberships must not render under this client's domain.
  const outsider = await hostGet("/dashboard/revenue-rescue", DOMAIN, { cookie: state.outsider });
  assert.equal(outsider.status, 200);
  assert.match(outsider.body, /No workspace yet/);
});

test("portal domain hides MogulForge chrome and marketing routes", async () => {
  const login = await hostGet("/login", DOMAIN);
  assert.equal(login.status, 200);
  assert.doesNotMatch(login.body, /Run the scan/); // marketing header CTA
  assert.doesNotMatch(login.body, /MOGULFORGE/); // wordmark in header/footer
  assert.match(login.body, /Powered by MogulForge/); // slim footer powered-by line

  for (const path of ["/services", "/revenue-rescue", "/signup"]) {
    const res = await hostGet(path, DOMAIN);
    assert.ok([302, 307, 308].includes(res.status), `${path}: expected redirect, got ${res.status}`);
    assert.ok(res.location?.endsWith("/"), `${path}: redirects to /, got ${res.location}`);
  }
});

test("platform host is unaffected (marketing home still renders on '/')", async () => {
  const res = await hostGet("/", `127.0.0.1:${BASE.port || 80}`);
  assert.equal(res.status, 200);
  assert.match(res.body, /Stop losing/);
});

test("removed domains stop routing immediately", async () => {
  await db.query("UPDATE custom_domains SET status = 'removed' WHERE id = $1", [state.domainId]);
  const root = await hostGet("/", DOMAIN);
  assert.equal(root.status, 200);
  assert.match(root.body, /isn(?:&#x27;|&apos;|')t serving a portal yet/);
  const login = await hostGet("/login", DOMAIN);
  assert.match(login.body, /isn(?:&#x27;|&apos;|')t serving a portal yet/);
  assert.doesNotMatch(login.body, new RegExp(`Welcome back to Acme ${RUN}`));
});
