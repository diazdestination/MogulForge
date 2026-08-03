/**
 * Integration tests for branded CRM connectors (HubSpot, GoHighLevel) — over
 * live HTTP against the dev server and the real database:
 * - provider catalog marks hubspot + gohighlevel as available
 * - provider-specific config validation (token / locationId required)
 * - credentials are redacted in every API response, and the placeholder
 *   echoed back on PATCH keeps the stored secret
 * - connection test hits the real provider API (invalid token → failed test)
 * - test-before-activate is still enforced for branded connectors
 * - lead.created pushes the mapped lead to active CRM connections
 * - inbound pull is blocked on inactive / outbound-only connections
 *
 * Requires the dev server on port 5000, DATABASE_URL, and ADMIN_PASSWORD.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import pg from "pg";

const BASE = process.env.TEST_BASE_URL ?? "http://127.0.0.1:5000";
const RUN = `crm${Date.now().toString(36)}`;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

async function request(path, { method = "GET", body, cookie, headers = {}, form } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
    redirect: "manual",
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  const sessionCookie = setCookie.map((c) => c.split(";")[0]).join("; ") || null;
  const json = (response.headers.get("content-type") ?? "").includes("application/json")
    ? await response.json().catch(() => null)
    : null;
  return { status: response.status, json, cookie: sessionCookie };
}

const state = {};
const received = [];
let receiver;
let receiverPort;

async function cleanup() {
  await db.query("DELETE FROM organizations WHERE slug LIKE 'test-crm%'");
  await db.query("DELETE FROM users WHERE email LIKE '%@rescue-crm-test.local'");
}

before(async () => {
  await db.connect();
  await cleanup();

  receiver = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      received.push({ url: req.url, raw });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  receiverPort = receiver.address().port;

  assert.ok(process.env.ADMIN_PASSWORD, "ADMIN_PASSWORD must be set for tests");
  const adminLogin = await request("/api/admin/session", { method: "POST", body: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(adminLogin.status, 200);

  const provision = await request("/api/admin/organizations", {
    method: "POST",
    cookie: adminLogin.cookie,
    body: {
      name: `Test ${RUN} Crm`,
      slug: `test-${RUN}`,
      plan: "growth",
      modules: ["revenue_rescue", "lead_import", "api_access"],
      usageLimits: { seats: 5 },
      owner: { email: `owner-${RUN}@rescue-crm-test.local`, name: "Owner" },
    },
  });
  assert.equal(provision.status, 201, JSON.stringify(provision.json));
  state.org = provision.json.organizationId;

  const accept = await request("/api/invites/accept", {
    method: "POST",
    body: { token: provision.json.inviteToken, name: "Owner", password: "password-crm-123" },
  });
  assert.equal(accept.status, 200);
  state.owner = accept.cookie;
});

after(async () => {
  await new Promise((resolve) => receiver.close(resolve));
  await cleanup();
  await db.end();
});

test("provider catalog: hubspot and gohighlevel are available", async () => {
  const res = await request(`/api/orgs/${state.org}/integrations/crm`, { cookie: state.owner });
  assert.equal(res.status, 200);
  const byId = Object.fromEntries(res.json.providers.map((p) => [p.id, p.status]));
  assert.equal(byId.hubspot, "available");
  assert.equal(byId.gohighlevel, "available");
});

test("provider config validation: hubspot needs a token, ghl needs token + location", async () => {
  const noToken = await request(`/api/orgs/${state.org}/integrations/crm`, {
    method: "POST",
    cookie: state.owner,
    body: { provider: "hubspot", name: "HS", config: {} },
  });
  assert.equal(noToken.status, 400);

  const noLocation = await request(`/api/orgs/${state.org}/integrations/crm`, {
    method: "POST",
    cookie: state.owner,
    body: { provider: "gohighlevel", name: "GHL", config: { apiKey: "pit-fake" } },
  });
  assert.equal(noLocation.status, 400);
});

test("hubspot: credentials redacted, placeholder keeps stored secret, test fails honestly, activation blocked", async () => {
  const created = await request(`/api/orgs/${state.org}/integrations/crm`, {
    method: "POST",
    cookie: state.owner,
    body: { provider: "hubspot", name: "HubSpot main", config: { accessToken: "pat-na1-not-a-real-token" } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const conn = created.json.connection;
  assert.equal(conn.config.accessToken, "__stored_secret__");
  state.hubspot = conn.id;

  // The list endpoint also never exposes the token.
  const list = await request(`/api/orgs/${state.org}/integrations/crm`, { cookie: state.owner });
  const listed = list.json.connections.find((c) => c.id === conn.id);
  assert.equal(listed.config.accessToken, "__stored_secret__");

  // PATCH echoing the placeholder back keeps the real stored token.
  const patched = await request(`/api/orgs/${state.org}/integrations/crm/${conn.id}`, {
    method: "PATCH",
    cookie: state.owner,
    body: { config: { accessToken: "__stored_secret__" }, name: "HubSpot renamed" },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.json));
  const dbRow = await db.query("SELECT config FROM crm_connections WHERE id = $1", [conn.id]);
  assert.equal(dbRow.rows[0].config.accessToken, "pat-na1-not-a-real-token");

  // Test hits the real HubSpot API — an invalid token must fail, not fake-pass.
  const tested = await request(`/api/orgs/${state.org}/integrations/crm/${conn.id}/test`, { method: "POST", cookie: state.owner });
  assert.equal(tested.status, 200);
  assert.equal(tested.json.result.ok, false);
  assert.match(tested.json.result.message, /HubSpot|Request failed/);

  // Without a passing test, activation stays blocked.
  const activate = await request(`/api/orgs/${state.org}/integrations/crm/${conn.id}`, {
    method: "PATCH",
    cookie: state.owner,
    body: { status: "active" },
  });
  assert.equal(activate.status, 409);
});

test("gohighlevel: create + failed test with fake credentials, pull blocked while inactive", async () => {
  const created = await request(`/api/orgs/${state.org}/integrations/crm`, {
    method: "POST",
    cookie: state.owner,
    body: { provider: "gohighlevel", name: "GHL main", config: { apiKey: "pit-not-real", locationId: "loc123" } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.connection.config.apiKey, "__stored_secret__");
  assert.equal(created.json.connection.config.locationId, "loc123");

  const tested = await request(`/api/orgs/${state.org}/integrations/crm/${created.json.connection.id}/test`, {
    method: "POST",
    cookie: state.owner,
  });
  assert.equal(tested.status, 200);
  assert.equal(tested.json.result.ok, false);

  const pull = await request(`/api/orgs/${state.org}/integrations/crm/${created.json.connection.id}/pull`, {
    method: "POST",
    cookie: state.owner,
  });
  assert.equal(pull.status, 409); // not active
});

test("lead.created pushes the mapped lead to active CRM connections", async () => {
  // Use the generic adapter with a local receiver so the push is fully observable.
  const created = await request(`/api/orgs/${state.org}/integrations/crm`, {
    method: "POST",
    cookie: state.owner,
    body: { provider: "generic_webhook", name: "Local CRM", config: { url: `http://127.0.0.1:${receiverPort}/crm` } },
  });
  assert.equal(created.status, 201);
  const connId = created.json.connection.id;

  const mapped = await request(`/api/orgs/${state.org}/integrations/crm/${connId}`, {
    method: "PATCH",
    cookie: state.owner,
    body: {
      fieldMapping: [
        { source: "firstName", target: "first_name", transform: "none" },
        { source: "email", target: "email", transform: "lowercase" },
      ],
    },
  });
  assert.equal(mapped.status, 200);

  const tested = await request(`/api/orgs/${state.org}/integrations/crm/${connId}/test`, { method: "POST", cookie: state.owner });
  assert.equal(tested.json.result.ok, true);
  const activated = await request(`/api/orgs/${state.org}/integrations/crm/${connId}`, {
    method: "PATCH",
    cookie: state.owner,
    body: { status: "active" },
  });
  assert.equal(activated.status, 200);

  // Create a lead through the public API (a lead.created site).
  const keyRes = await request(`/api/orgs/${state.org}/integrations/api-keys`, {
    method: "POST",
    cookie: state.owner,
    body: { name: "CRM test", scopes: ["leads:write"] },
  });
  assert.equal(keyRes.status, 201);
  received.length = 0;
  const lead = await request(`/api/v1/leads`, {
    method: "POST",
    headers: { Authorization: `Bearer ${keyRes.json.rawKey}` },
    body: { firstName: "Casey", lastName: "Nguyen", email: `casey-${RUN}@Example.com` },
  });
  assert.equal(lead.status, 201, JSON.stringify(lead.json));

  // Wait for the background push to land on the receiver.
  let pushBody = null;
  for (let i = 0; i < 40 && !pushBody; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const hit = received.find((r) => r.url === "/crm");
    if (hit) pushBody = JSON.parse(hit.raw);
  }
  assert.ok(pushBody, "CRM push never reached the receiver");
  assert.equal(pushBody._source, "revenue_rescue");
  assert.equal(pushBody.data.first_name, "Casey");
  assert.equal(pushBody.data.email, `casey-${RUN}@example.com`);
});

test("suppressed leads from single-lead intake are withheld from CRM push", async () => {
  // Seed a do-not-contact record, then create a matching lead via the public API.
  await db.query(
    "INSERT INTO suppression_records (organization_id, channel, value, reason, source) VALUES ($1, 'email', $2, 'opt_out', 'test')",
    [state.org, `dnc-${RUN}@rescue-crm-test.local`],
  );
  const keyRes = await request(`/api/orgs/${state.org}/integrations/api-keys`, {
    method: "POST",
    cookie: state.owner,
    body: { name: "CRM suppression test", scopes: ["leads:write"] },
  });
  received.length = 0;
  const lead = await request(`/api/v1/leads`, {
    method: "POST",
    headers: { Authorization: `Bearer ${keyRes.json.rawKey}` },
    body: { firstName: "Dee", lastName: "NoContact", email: `dnc-${RUN}@rescue-crm-test.local` },
  });
  assert.equal(lead.status, 201, JSON.stringify(lead.json));
  assert.equal(lead.json.data.suppressed, true);

  await new Promise((r) => setTimeout(r, 3000));
  assert.equal(received.filter((r) => r.url === "/crm").length, 0, "suppressed lead must not be pushed to CRM");
});

test("bulk import pushes imported (non-suppressed) leads to active CRM connections", async () => {
  const csv = [
    "First Name,Last Name,Email,Phone,Consent",
    `Ana,Silva,ana-${RUN}@rescue-crm-test.local,555-644-9001,yes`,
    `Ben,Okafor,ben-${RUN}@rescue-crm-test.local,555-644-9002,`,
    `Opt,Out,optout-${RUN}@rescue-crm-test.local,555-644-9003,opted_out`,
  ].join("\n");
  const upload = (() => {
    const formData = new FormData();
    formData.append("file", new File([csv], "crm-import.csv", { type: "text/csv" }));
    return formData;
  })();
  received.length = 0;

  const uploaded = await request(`/api/orgs/${state.org}/imports`, { method: "POST", cookie: state.owner, form: upload });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.json));
  const importId = uploaded.json.import.id;
  const mapping = Object.fromEntries(uploaded.json.import.autoMapping.map((m) => [m.sourceColumn, m.target]));
  const confirm = await request(`/api/orgs/${state.org}/imports/${importId}/mapping`, {
    method: "POST",
    cookie: state.owner,
    body: { mapping },
  });
  assert.equal(confirm.status, 200, JSON.stringify(confirm.json));

  // Wait for the import to finish and the background push to reach the receiver.
  let record = null;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const res = await request(`/api/orgs/${state.org}/imports/${importId}`, { cookie: state.owner });
    record = res.json?.import;
    if (record && ["complete", "failed", "partial"].includes(record.status)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(record && record.status === "complete", JSON.stringify(record));
  assert.equal(record.importedCount, 3);

  let pushes = [];
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    pushes = received.filter((r) => r.url === "/crm").map((r) => JSON.parse(r.raw));
    if (pushes.length >= 2) break;
  }
  const emails = pushes.map((p) => p.data.email).sort();
  // Two contactable leads pushed; the opted-out (suppressed) lead is deliberately withheld.
  assert.deepEqual(emails, [`ana-${RUN}@rescue-crm-test.local`, `ben-${RUN}@rescue-crm-test.local`]);
});
