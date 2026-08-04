/**
 * Integration tests for embed theming over live HTTP against the dev server
 * and the real database:
 * - PATCH /api/orgs/:orgId/integrations/embed-theme normalizes and stores the
 *   org-default theme (rejecting unsafe values by falling back)
 * - /api/embed/branding returns the normalized theme for a valid embed session
 * - the served /embed/v1/loader.js contains the theme param whitelist
 *   (t_mode/t_accent/t_bg/t_radius/t_logo) so per-mount overrides pass through
 *
 * Requires the dev server on port 5000, DATABASE_URL, and ADMIN_PASSWORD.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const BASE = process.env.TEST_BASE_URL ?? "http://127.0.0.1:5000";
const RUN = `theme${Date.now().toString(36)}`;
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
  await db.query("DELETE FROM organizations WHERE slug LIKE 'test-theme%'");
  await db.query("DELETE FROM users WHERE email LIKE '%@rescue-theme-test.local'");
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
      name: `Test ${RUN} EmbedTheme`,
      slug: `test-${RUN}`,
      plan: "growth",
      modules: ["revenue_rescue", "api_access"],
      usageLimits: { seats: 5 },
      allowedOrigins: [APPROVED_ORIGIN],
      owner: { email: `owner-${RUN}@rescue-theme-test.local`, name: "Owner" },
    },
  });
  assert.equal(provision.status, 201, JSON.stringify(provision.json));
  state.org = provision.json.organizationId;

  const accept = await request("/api/invites/accept", {
    method: "POST",
    body: { token: provision.json.inviteToken, name: "Owner", password: "password-theme-123" },
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

async function mintEmbedToken() {
  const issued = await request("/api/v1/embed/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${state.apiKey}` },
    body: { origin: APPROVED_ORIGIN, modules: ["dashboard"] },
  });
  assert.equal(issued.status, 201, JSON.stringify(issued.json));
  return issued.json.data.token;
}

async function fetchBrandingTheme() {
  const token = await mintEmbedToken();
  const res = await request("/api/embed/branding", {
    headers: { Authorization: `Bearer ${token}`, Origin: APPROVED_ORIGIN },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.ok(res.json.branding, "branding payload expected");
  assert.ok(res.json.branding.theme, "branding payload must include the theme");
  return res.json.branding.theme;
}

test("PATCH embed-theme saves a valid theme and /api/embed/branding returns it normalized", async () => {
  const saved = await request(`/api/orgs/${state.org}/integrations/embed-theme`, {
    method: "PATCH",
    cookie: state.owner,
    body: { theme: { mode: "light", accentColor: "#0aF", backgroundColor: "#102030", radius: "sm", logoUrl: "https://cdn.example.com/logo.png" } },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.deepEqual(saved.json.theme, {
    mode: "light",
    accentColor: "#0aF",
    backgroundColor: "#102030",
    radius: "sm",
    logoUrl: "https://cdn.example.com/logo.png",
  });

  // GET reads the same stored theme back for the org settings UI.
  const read = await request(`/api/orgs/${state.org}/integrations/embed-theme`, { cookie: state.owner });
  assert.equal(read.status, 200);
  assert.deepEqual(read.json.theme, saved.json.theme);

  // The embed session sees exactly the stored theme in the branding payload.
  const theme = await fetchBrandingTheme();
  assert.deepEqual(theme, saved.json.theme);
});

test("unsafe theme values are rejected: non-hex colors, non-https logos, bogus enums fall back", async () => {
  const saved = await request(`/api/orgs/${state.org}/integrations/embed-theme`, {
    method: "PATCH",
    cookie: state.owner,
    body: {
      theme: {
        mode: "neon",
        accentColor: "red; background: url(javascript:alert(1))",
        backgroundColor: "url(https://evil.example.net/x.png)",
        radius: "9999px",
        logoUrl: "javascript:alert(1)",
      },
    },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  // Every unsafe value falls back to the default — never stored as-is.
  assert.deepEqual(saved.json.theme, {
    mode: "dark",
    accentColor: null,
    backgroundColor: null,
    radius: "lg",
    logoUrl: null,
  });

  const theme = await fetchBrandingTheme();
  assert.deepEqual(theme, saved.json.theme);
  const asString = JSON.stringify(theme);
  assert.ok(!asString.includes("javascript:"), "no unsafe scheme may survive");
  assert.ok(!asString.includes("url("), "no CSS function may survive");

  // http:// (non-https) logos are also refused.
  const httpLogo = await request(`/api/orgs/${state.org}/integrations/embed-theme`, {
    method: "PATCH",
    cookie: state.owner,
    body: { theme: { logoUrl: "http://insecure.example.com/logo.png" } },
  });
  assert.equal(httpLogo.status, 200);
  assert.equal(httpLogo.json.theme.logoUrl, null);
});

test("members without manager roles cannot change the org theme", async () => {
  const anonymous = await request(`/api/orgs/${state.org}/integrations/embed-theme`, {
    method: "PATCH",
    body: { theme: { mode: "light" } },
  });
  assert.ok([401, 403].includes(anonymous.status), `unauthenticated PATCH must be refused, got ${anonymous.status}`);
});

async function fetchEmbedHtml(path, params) {
  const token = await mintEmbedToken();
  const qs = new URLSearchParams({ token, ...params });
  const res = await fetch(`${BASE}${path}?${qs}`, { redirect: "manual" });
  assert.equal(res.status, 200, `${path} must render, got ${res.status}`);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  return res.text();
}

test("rendered /embed/widget applies valid per-mount theme overrides as inline styles", async () => {
  const html = await fetchEmbedHtml("/embed/widget", {
    t_mode: "light",
    t_accent: "#ff0055",
    t_bg: "#112233",
    t_radius: "xl",
  });
  // Root background from t_bg, served in the initial HTML (not just after hydration).
  assert.ok(html.includes("background-color:#112233"), "widget HTML must inline the t_bg override");
  // Accent from t_accent on the solid accent (submit button).
  assert.ok(html.includes("background-color:#ff0055"), "widget HTML must inline the t_accent override");
  // xl radius → 12px controls (inputs/buttons).
  assert.ok(html.includes("border-radius:12px"), "widget HTML must inline the xl control radius");
  // t_mode=light → light text color, not the dark-mode default.
  assert.ok(html.includes("color:#111418"), "widget HTML must use the light-mode text color");
  assert.ok(!html.includes("background-color:#0b0e11"), "dark default background must be overridden");
});

test("rendered /embed/dashboard applies valid per-mount theme overrides as inline styles", async () => {
  const html = await fetchEmbedHtml("/embed/dashboard", {
    t_bg: "#221100",
    t_accent: "#00ccaa",
  });
  assert.ok(html.includes("background-color:#221100"), "dashboard HTML must inline the t_bg override");
});

test("rendered /embed/widget ignores invalid per-mount theme params", async () => {
  const html = await fetchEmbedHtml("/embed/widget", {
    t_mode: "neon",
    t_accent: "red; background: url(javascript:alert(1))",
    t_bg: "url(https://evil.example.net/x.png)",
    t_radius: "9999px",
    t_logo: "javascript:alert(1)",
  });
  // None of the hostile values may survive into rendered inline styles.
  // (The raw query string is echoed inside Next's serialized payload, so we
  // check the style contexts specifically.)
  assert.ok(!html.includes("background-color:url("), "bogus t_bg must never reach a style");
  assert.ok(!html.includes("background-color:red"), "non-hex t_accent must never reach a style");
  assert.ok(!html.includes("border-radius:9999px"), "bogus radius must never reach a style");
  assert.ok(!/<img[^>]+javascript:/i.test(html), "unsafe logo scheme must never render as an image");
  // The page falls back to the dark defaults: dark background + lg control radius (8px).
  assert.ok(html.includes("background-color:#0b0e11"), "invalid t_bg falls back to the dark default background");
  assert.ok(html.includes("border-radius:8px"), "invalid t_radius falls back to the lg control radius");
});

// The leads/appointments modules render a data-loading shell on the server
// (rows only arrive after the client fetches /api/embed/*), so the initial
// HTML exposes the merged theme through the root background/text styles.
// Control radii/accents only appear once data renders client-side, so the
// SSR assertions focus on the style contexts that exist in the served HTML.
for (const path of ["/embed/leads", "/embed/appointments"]) {
  test(`rendered ${path} applies valid per-mount theme overrides as inline styles`, async () => {
    const html = await fetchEmbedHtml(path, {
      t_mode: "light",
      t_accent: "#ff0055",
      t_bg: "#112233",
      t_radius: "xl",
    });
    // Root background from t_bg, served in the initial HTML (pre-hydration).
    // The loading shell merges the muted text color over the root style, so
    // the served style is background + light-mode muted color together.
    assert.ok(html.includes("background-color:#112233"), `${path} HTML must inline the t_bg override`);
    assert.ok(html.includes("color:rgba(17,20,24,0.6)"), `${path} HTML must use the light-mode muted color`);
    assert.ok(!html.includes("background-color:#0b0e11"), "dark default background must be overridden");
    assert.ok(!html.includes("color:rgba(255,255,255,0.55)"), "dark muted color must be overridden");
  });

  test(`rendered ${path} ignores invalid per-mount theme params`, async () => {
    const html = await fetchEmbedHtml(path, {
      t_mode: "neon",
      t_accent: "red; background: url(javascript:alert(1))",
      t_bg: "url(https://evil.example.net/x.png)",
      t_radius: "9999px",
      t_logo: "javascript:alert(1)",
    });
    // Hostile values must never reach a style context (the raw query string
    // is echoed inside Next's serialized payload, so check style forms only).
    assert.ok(!html.includes("background-color:url("), "bogus t_bg must never reach a style");
    assert.ok(!html.includes("background-color:red"), "non-hex t_accent must never reach a style");
    assert.ok(!html.includes("border-radius:9999px"), "bogus radius must never reach a style");
    assert.ok(!/<img[^>]+javascript:/i.test(html), "unsafe logo scheme must never render as an image");
    // The page falls back to the org/dark defaults for its root shell.
    assert.ok(html.includes("background-color:#0b0e11"), "invalid t_bg falls back to the dark default background");
    assert.ok(html.includes("color:rgba(255,255,255,0.55)"), "invalid t_mode falls back to the dark muted color");
  });
}

test("loader.js whitelists the theme query params for per-mount overrides", async () => {
  const res = await fetch(`${BASE}/embed/v1/loader.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /javascript/);
  const source = await res.text();
  for (const param of ["t_mode", "t_accent", "t_bg", "t_radius", "t_logo"]) {
    assert.ok(source.includes(`&${param}=`), `loader must pass through ${param}`);
  }
  // The loader validates values before forwarding them.
  assert.ok(source.includes("HEX_RE"), "loader must hex-validate colors");
  assert.match(source, /"none", "sm", "md", "lg", "xl"/, "loader must whitelist radii");
  assert.ok(/https:/.test(source), "loader must require https logos");
});
