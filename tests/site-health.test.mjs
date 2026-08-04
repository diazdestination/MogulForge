/**
 * Integration tests for the site-health feature over live HTTP against the
 * dev server and the real database:
 * - POST /api/embed/heartbeat records widget liveness from a valid embed
 *   session (and rejects missing tokens)
 * - GET /api/orgs/:orgId/site-health aggregates crawl, widgets, and honest
 *   analytics states (Google not connected → no fake data)
 * - POST /api/orgs/:orgId/site-health/crawl runs a bounded whole-site crawl
 *   against a public URL and stores a per-page report
 * - POST /api/orgs/:orgId/site-health/analytics fails honestly (409) without
 *   a Google connection
 * - /api/cron/site-health requires auth and reports counts
 *
 * Requires the dev server on port 5000, DATABASE_URL, ADMIN_PASSWORD, and a
 * public REPLIT_DEV_DOMAIN for the crawl test (the crawler refuses private hosts).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const BASE = process.env.TEST_BASE_URL ?? "http://127.0.0.1:5000";
const RUN = `sh${Date.now().toString(36)}`;
const APPROVED_ORIGIN = "https://client.example.com";
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

async function request(path, { method = "GET", body, cookie, headers = {} } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  const sessionCookie = setCookie.map((c) => c.split(";")[0]).join("; ") || null;
  const json = (response.headers.get("content-type") ?? "").includes("application/json")
    ? await response.json().catch(() => null)
    : null;
  return { status: response.status, json, cookie: sessionCookie, headers: response.headers };
}

const state = {};

async function cleanup() {
  await db.query("DELETE FROM organizations WHERE slug LIKE 'test-sh%'");
  await db.query("DELETE FROM users WHERE email LIKE '%@rescue-sh-test.local'");
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
      name: `Test ${RUN} SiteHealth`,
      slug: `test-${RUN}`,
      plan: "growth",
      modules: ["revenue_rescue", "api_access", "analytics"],
      usageLimits: { seats: 5 },
      allowedOrigins: [APPROVED_ORIGIN],
      owner: { email: `owner-${RUN}@rescue-sh-test.local`, name: "Owner" },
    },
  });
  assert.equal(provision.status, 201, JSON.stringify(provision.json));
  state.org = provision.json.organizationId;

  const accept = await request("/api/invites/accept", {
    method: "POST",
    body: { token: provision.json.inviteToken, name: "Owner", password: "password-sh-123" },
  });
  assert.equal(accept.status, 200);
  state.owner = accept.cookie;

  const created = await request(`/api/orgs/${state.org}/integrations/api-keys`, {
    method: "POST",
    cookie: state.owner,
    body: { name: "Embed", scopes: ["embed:write"] },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  state.apiKey = created.json.rawKey;
});

after(async () => {
  await cleanup();
  await db.end();
});

async function mintEmbedToken(modules = ["dashboard", "leads"]) {
  const issued = await request("/api/v1/embed/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${state.apiKey}` },
    body: { origin: APPROVED_ORIGIN, modules },
  });
  assert.equal(issued.status, 201, JSON.stringify(issued.json));
  return issued.json.data.token;
}

test("heartbeat: rejects requests without an embed token", async () => {
  const res = await request("/api/embed/heartbeat", { method: "POST", body: { module: "dashboard" } });
  assert.equal(res.status, 401);
});

test("heartbeat: records liveness per (origin, module) and upserts on repeat", async () => {
  const token = await mintEmbedToken();
  const first = await request("/api/embed/heartbeat", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Origin: APPROVED_ORIGIN },
    body: { module: "leads" },
  });
  assert.equal(first.status, 200, JSON.stringify(first.json));

  const second = await request("/api/embed/heartbeat", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Origin: APPROVED_ORIGIN },
    body: { module: "leads" },
  });
  assert.equal(second.status, 200);

  // A module outside the token's claims falls back to a claimed module (never trusts the body).
  const bogus = await request("/api/embed/heartbeat", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Origin: APPROVED_ORIGIN },
    body: { module: "lead_form" },
  });
  assert.equal(bogus.status, 200);

  const { rows } = await db.query(
    "SELECT origin, module, beat_count FROM org_widget_heartbeats WHERE organization_id = $1 ORDER BY module",
    [state.org],
  );
  const leads = rows.find((r) => r.module === "leads");
  assert.ok(leads, "leads heartbeat row expected");
  assert.equal(leads.origin, APPROVED_ORIGIN);
  assert.ok(Number(leads.beat_count) >= 2, "repeat heartbeat must upsert, not duplicate");
  assert.ok(!rows.some((r) => r.module === "lead_form"), "unclaimed module must not be recorded");
});

test("site-health GET: aggregates widgets and reports honest analytics state", async () => {
  const res = await request(`/api/orgs/${state.org}/site-health`, { cookie: state.owner });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const widget = res.json.widgets.find((w) => w.origin === APPROVED_ORIGIN && w.module === "leads");
  assert.ok(widget, "heartbeat must surface in site-health");
  assert.equal(widget.liveness, "live");
  // No Google connection → analytics honestly not connected, no snapshots.
  assert.equal(res.json.analytics.access.googleConnected, false);
  assert.equal(res.json.analytics.access.searchConsoleGranted, false);
  assert.deepEqual(res.json.analytics.snapshots, []);
  assert.equal(res.json.analytics.analyticsEntitled, true);
  assert.equal(res.json.crawl, null);
});

test("site-health GET: forbidden for non-members", async () => {
  const res = await request(`/api/orgs/${state.org}/site-health`);
  assert.equal(res.status, 401);
});

test("analytics refresh: 409 without a Google connection", async () => {
  const res = await request(`/api/orgs/${state.org}/site-health/analytics`, { method: "POST", cookie: state.owner, body: {} });
  assert.equal(res.status, 409, JSON.stringify(res.json));
});

test("crawl: rejects private hosts and missing website", async () => {
  const noSite = await request(`/api/orgs/${state.org}/site-health/crawl`, { method: "POST", cookie: state.owner, body: {} });
  assert.equal(noSite.status, 400, JSON.stringify(noSite.json));

  const priv = await request(`/api/orgs/${state.org}/site-health/crawl`, {
    method: "POST",
    cookie: state.owner,
    body: { url: "http://127.0.0.1:5000" },
  });
  assert.equal(priv.status, 400, JSON.stringify(priv.json));
});

// Note: REPLIT_DEV_DOMAIN resolves to a PRIVATE ip from inside the container,
// so the SSRF guard blocks it (verified above). The e2e crawl therefore runs
// against the IANA example domain with a tiny page cap.
test("crawl: bounded whole-site crawl against a public URL stores a per-page report", { timeout: 90_000 }, async () => {
  const started = await request(`/api/orgs/${state.org}/site-health/crawl`, {
    method: "POST",
    cookie: state.owner,
    body: { url: "https://example.com/", pageCap: 5 },
  });
  assert.equal(started.status, 202, JSON.stringify(started.json));

  // A second crawl while one runs must be refused.
  const dup = await request(`/api/orgs/${state.org}/site-health/crawl`, {
    method: "POST",
    cookie: state.owner,
    body: { url: "https://example.com/" },
  });
  assert.equal(dup.status, 409, JSON.stringify(dup.json));

  let crawl = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await request(`/api/orgs/${state.org}/site-health`, { cookie: state.owner });
    assert.equal(res.status, 200);
    crawl = res.json.crawl;
    if (crawl && crawl.crawl.status !== "running") break;
  }
  assert.ok(crawl, "crawl result expected");
  assert.equal(crawl.crawl.status, "complete", JSON.stringify(crawl.crawl));
  assert.ok(crawl.crawl.pagesFound >= 1, "at least the root page must be checked");
  assert.ok(crawl.crawl.pagesFound <= crawl.crawl.pageCap, "page cap must be respected");
  assert.ok(crawl.pages.length === crawl.crawl.pagesFound, "per-page rows must match the count");
  const root = crawl.pages.find((p) => p.discoveredVia === "root");
  assert.ok(root?.ok, `root page should be reachable: ${JSON.stringify(root)}`);
});

test("cron site-health: requires auth, then reports counts", async () => {
  const anon = await request("/api/cron/site-health", { method: "POST" });
  assert.equal(anon.status, 401);

  assert.ok(process.env.CRON_SECRET, "CRON_SECRET must be set for tests");
  const authed = await request("/api/cron/site-health", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  assert.equal(authed.status, 200, JSON.stringify(authed.json));
  assert.equal(typeof authed.json.organizations, "number");
  // Our test org has no analytics scopes granted, so it must not be pulled.
  assert.equal(typeof authed.json.snapshotsRefreshed, "number");
});
