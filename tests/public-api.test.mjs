/**
 * Integration tests for the public API, webhooks, and embeds — over live HTTP
 * against the dev server and the real database:
 * - API key lifecycle: create (shown once), scope enforcement, revoke
 * - /api/v1 auth, structured errors, pagination envelope, idempotency replay
 * - incoming webhooks: valid signature, bad signature, stale timestamp (replay),
 *   duplicate event idempotency, opt-out processing
 * - outgoing webhooks: real delivery to a local receiver with valid signature,
 *   failure handling + manual retry
 * - embed sessions: origin allow-list enforcement, embed API access with token
 *
 * Requires the dev server on port 5000, DATABASE_URL, and ADMIN_PASSWORD.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import pg from "pg";

const BASE = process.env.TEST_BASE_URL ?? "http://127.0.0.1:5000";
const RUN = `papi${Date.now().toString(36)}`;
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

function signPayload(secret, timestamp, rawBody) {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

/** Sends a signed incoming webhook event. */
async function sendIncoming(token, secret, event, { timestamp, badSignature } = {}) {
  const rawBody = JSON.stringify(event);
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const signature = badSignature ? `v1=${"0".repeat(64)}` : signPayload(secret, ts, rawBody);
  const response = await fetch(`${BASE}/api/webhooks/incoming/${token}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-RevenueRescue-Timestamp": String(ts),
      "X-RevenueRescue-Signature": signature,
    },
    body: rawBody,
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

const state = {};
const received = []; // requests captured by the local webhook receiver
let receiver;
let receiverPort;
let receiverStatus = 200;

async function cleanup() {
  await db.query("DELETE FROM organizations WHERE slug LIKE 'test-papi%'");
  await db.query("DELETE FROM users WHERE email LIKE '%@rescue-papi-test.local'");
}

before(async () => {
  await db.connect();
  await cleanup();

  // Local HTTP receiver for outgoing webhook deliveries.
  receiver = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      received.push({ headers: req.headers, raw });
      res.writeHead(receiverStatus, { "Content-Type": "application/json" });
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
      name: `Test ${RUN} PublicApi`,
      slug: `test-${RUN}`,
      plan: "growth",
      modules: ["revenue_rescue", "lead_import", "api_access"],
      usageLimits: { seats: 5 },
      allowedOrigins: [APPROVED_ORIGIN],
      owner: { email: `owner-${RUN}@rescue-papi-test.local`, name: "Owner" },
    },
  });
  assert.equal(provision.status, 201, JSON.stringify(provision.json));
  state.org = provision.json.organizationId;

  const accept = await request("/api/invites/accept", {
    method: "POST",
    body: { token: provision.json.inviteToken, name: "Owner", password: "password-papi-123" },
  });
  assert.equal(accept.status, 200);
  state.owner = accept.cookie;
});

after(async () => {
  await new Promise((resolve) => receiver.close(resolve));
  await cleanup();
  await db.end();
});

test("API keys: created once with raw key, listed hashed, and enforced on /api/v1", async () => {
  const created = await request(`/api/orgs/${state.org}/integrations/api-keys`, {
    method: "POST",
    cookie: state.owner,
    body: { name: "Full access", scopes: ["leads:read", "leads:write", "appointments:read", "appointments:write", "webhooks:read", "webhooks:write", "usage:read", "embed:write"] },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.match(created.json.rawKey, /^rrk_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$/);
  state.apiKey = created.json.rawKey;
  state.apiKeyId = created.json.key.id;

  // The list never exposes the raw key — only the prefix.
  const list = await request(`/api/orgs/${state.org}/integrations/api-keys`, { cookie: state.owner });
  assert.equal(list.status, 200);
  const row = list.json.keys.find((k) => k.id === state.apiKeyId);
  assert.ok(row);
  assert.ok(!JSON.stringify(list.json).includes(state.apiKey.slice(-20)), "raw key must not be retrievable");
  assert.ok(state.apiKey.startsWith(row.prefix));

  // No auth → structured 401.
  const noAuth = await request("/api/v1/leads");
  assert.equal(noAuth.status, 401);
  assert.equal(noAuth.json.error.code, "missing_api_key");

  // Garbage key → 401.
  const badAuth = await request("/api/v1/leads", { headers: { Authorization: "Bearer rrk_bogus_bogus" } });
  assert.equal(badAuth.status, 401);
  assert.equal(badAuth.json.error.code, "invalid_api_key");

  // Valid key → 200 with pagination envelope and rate-limit headers.
  const ok = await request("/api/v1/leads?limit=5", { headers: { Authorization: `Bearer ${state.apiKey}` } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(Object.keys(ok.json.pagination).sort(), ["has_more", "limit", "offset", "total"]);
  assert.ok(Number(ok.headers.get("x-ratelimit-limit")) > 0);
});

test("scopes are enforced per key; revoked keys stop working", async () => {
  const created = await request(`/api/orgs/${state.org}/integrations/api-keys`, {
    method: "POST",
    cookie: state.owner,
    body: { name: "Metrics only", scopes: ["metrics:read"] },
  });
  assert.equal(created.status, 201);
  const narrowKey = created.json.rawKey;

  const denied = await request("/api/v1/leads", { headers: { Authorization: `Bearer ${narrowKey}` } });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error.code, "insufficient_scope");

  const allowed = await request("/api/v1/metrics", { headers: { Authorization: `Bearer ${narrowKey}` } });
  assert.equal(allowed.status, 200);

  const revoked = await request(`/api/orgs/${state.org}/integrations/api-keys/${created.json.key.id}`, { method: "DELETE", cookie: state.owner });
  assert.equal(revoked.status, 200);
  const afterRevoke = await request("/api/v1/metrics", { headers: { Authorization: `Bearer ${narrowKey}` } });
  assert.equal(afterRevoke.status, 401);
});

test("POST /v1/leads: idempotency replay, body-mismatch conflict, duplicate detection", async () => {
  const headers = { Authorization: `Bearer ${state.apiKey}`, "Idempotency-Key": `lead-${RUN}` };
  const body = { firstName: "Idem", lastName: "Potent", email: `idem-${RUN}@rescue-papi-test.local`, source: "api-test" };

  const first = await request("/api/v1/leads", { method: "POST", headers, body });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  state.leadId = first.json.data.id;

  // Same key + same body → replayed stored response.
  const replay = await request("/api/v1/leads", { method: "POST", headers, body });
  assert.equal(replay.status, 201);
  assert.equal(replay.json.data.id, state.leadId);
  assert.equal(replay.headers.get("idempotency-replayed"), "true");

  // Same key + different body → 409.
  const mismatch = await request("/api/v1/leads", { method: "POST", headers, body: { ...body, firstName: "Changed" } });
  assert.equal(mismatch.status, 409);

  // New idempotency key but same email → duplicate lead, with the existing id.
  const dup = await request("/api/v1/leads", {
    method: "POST",
    headers: { Authorization: `Bearer ${state.apiKey}`, "Idempotency-Key": `lead-${RUN}-2` },
    body,
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, "duplicate_lead");
  assert.equal(dup.json.error.details.existing_lead_id, state.leadId);

  // The lead is readable through the API.
  const detail = await request(`/api/v1/leads/${state.leadId}`, { headers: { Authorization: `Bearer ${state.apiKey}` } });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.data.email, body.email);
});

test("idempotency is concurrency-safe: parallel POSTs with one key execute the write exactly once", async () => {
  // Appointments need a lead to attach to.
  const lead = await request("/api/v1/leads", {
    method: "POST",
    headers: { Authorization: `Bearer ${state.apiKey}` },
    body: { firstName: "Race", email: `race-${RUN}@rescue-papi-test.local` },
  });
  assert.equal(lead.status, 201, JSON.stringify(lead.json));
  const leadId = lead.json.data.id;

  const headers = { Authorization: `Bearer ${state.apiKey}`, "Idempotency-Key": `appt-race-${RUN}` };
  const body = { leadId, appointmentType: "estimate", scheduledStart: new Date(Date.now() + 86_400_000).toISOString() };
  const results = await Promise.all(
    Array.from({ length: 5 }, () => request("/api/v1/appointments", { method: "POST", headers, body })),
  );
  const statuses = results.map((r) => r.status).sort();
  // Exactly one request wins the reservation; the rest are replays (201 with
  // the same appointment) or 409 idempotency_in_progress — never a second write.
  for (const r of results) {
    assert.ok([201, 409].includes(r.status), `unexpected status ${r.status}: ${JSON.stringify(r.json)}`);
    if (r.status === 409) assert.equal(r.json.error.code, "idempotency_in_progress");
  }
  assert.ok(statuses.includes(201), "one request must succeed");
  const created = new Set(results.filter((r) => r.status === 201).map((r) => r.json.data.id));
  assert.equal(created.size, 1, "all 201 responses must be the same appointment");

  const { rows } = await db.query("SELECT count(*)::int AS n FROM rescue_appointments WHERE organization_id = $1 AND lead_id = $2", [state.org, leadId]);
  assert.equal(rows[0].n, 1, "exactly one appointment row despite 5 concurrent requests");

  // A failed request releases the reservation so the key can be retried.
  const failHeaders = { Authorization: `Bearer ${state.apiKey}`, "Idempotency-Key": `appt-fail-${RUN}` };
  const badBody = { leadId, appointmentType: "estimate", scheduledStart: "not-a-date" };
  const failed = await request("/api/v1/appointments", { method: "POST", headers: failHeaders, body: badBody });
  assert.equal(failed.status, 422);
  const retryOk = await request("/api/v1/appointments", {
    method: "POST",
    headers: failHeaders,
    body: { leadId, appointmentType: "estimate", scheduledStart: new Date(Date.now() + 172_800_000).toISOString() },
  });
  assert.equal(retryOk.status, 201, `key must be reusable after a failed attempt: ${JSON.stringify(retryOk.json)}`);
});

test("incoming webhooks: signature, replay window, and event idempotency", async () => {
  const created = await request(`/api/orgs/${state.org}/integrations/incoming-webhooks`, {
    method: "POST",
    cookie: state.owner,
    body: { name: "Test source" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const { token, secret } = created.json.endpoint;

  // Bad signature → 401, nothing stored.
  const bad = await sendIncoming(token, secret, { id: `evt-${RUN}-bad`, type: "ping", data: {} }, { badSignature: true });
  assert.equal(bad.status, 401);

  // Stale timestamp → rejected as possible replay.
  const stale = await sendIncoming(token, secret, { id: `evt-${RUN}-stale`, type: "ping", data: {} }, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
  assert.equal(stale.status, 400);
  assert.equal(stale.json.error.code, "timestamp_out_of_tolerance");

  // Valid lead.created → processed, creates the lead.
  const email = `hook-${RUN}@rescue-papi-test.local`;
  const ok = await sendIncoming(token, secret, { id: `evt-${RUN}-1`, type: "lead.created", data: { email, firstName: "Hooked", source: "crm" } });
  assert.equal(ok.status, 202, JSON.stringify(ok.json));
  assert.equal(ok.json.status, "processed");
  const { rows } = await db.query("SELECT id, suppressed FROM rescue_leads WHERE organization_id = $1 AND email_normalized = $2", [state.org, email]);
  assert.equal(rows.length, 1);
  state.hookLeadId = rows[0].id;

  // Exact same event id again → idempotent, no second lead.
  const dup = await sendIncoming(token, secret, { id: `evt-${RUN}-1`, type: "lead.created", data: { email, firstName: "Hooked", source: "crm" } });
  assert.equal(dup.status, 200);
  assert.equal(dup.json.duplicate, true);
  const again = await db.query("SELECT count(*)::int AS n FROM rescue_leads WHERE organization_id = $1 AND email_normalized = $2", [state.org, email]);
  assert.equal(again.rows[0].n, 1);

  // contact.opted_out suppresses the lead.
  const optOut = await sendIncoming(token, secret, { id: `evt-${RUN}-2`, type: "contact.opted_out", data: { email } });
  assert.equal(optOut.status, 202, JSON.stringify(optOut.json));
  const suppressed = await db.query("SELECT suppressed FROM rescue_leads WHERE id = $1", [state.hookLeadId]);
  assert.equal(suppressed.rows[0].suppressed, true);
});

test("outgoing webhooks: signed delivery to a real receiver, failure + manual retry", async () => {
  receiverStatus = 200;
  const created = await request(`/api/orgs/${state.org}/integrations/outgoing-webhooks`, {
    method: "POST",
    cookie: state.owner,
    body: { url: `http://127.0.0.1:${receiverPort}/hook`, eventTypes: ["test.ping", "lead.created"] },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const endpoint = created.json.endpoint;

  // Send a test event — delivered synchronously with a valid signature.
  const testSend = await request(`/api/orgs/${state.org}/integrations/outgoing-webhooks/${endpoint.id}/test`, { method: "POST", cookie: state.owner });
  assert.equal(testSend.status, 200);
  assert.equal(testSend.json.delivery.status, "succeeded", JSON.stringify(testSend.json.delivery));
  assert.equal(received.length, 1);
  const hit = received[0];
  const sig = hit.headers["x-revenuerescue-signature"];
  const ts = hit.headers["x-revenuerescue-timestamp"];
  assert.ok(sig && ts, "delivery must be signed");
  assert.equal(sig, signPayload(endpoint.secret, ts, hit.raw), "signature must verify with the endpoint secret");
  assert.equal(JSON.parse(hit.raw).type, "test.ping");

  // Failing receiver → delivery recorded as failed with a scheduled retry; manual retry succeeds after recovery.
  receiverStatus = 500;
  const failSend = await request(`/api/orgs/${state.org}/integrations/outgoing-webhooks/${endpoint.id}/test`, { method: "POST", cookie: state.owner });
  assert.equal(failSend.json.delivery.status, "failed");
  assert.equal(failSend.json.delivery.lastStatusCode, 500);
  assert.ok(failSend.json.delivery.nextAttemptAt, "failed delivery must schedule a retry");

  receiverStatus = 200;
  const retried = await request(`/api/orgs/${state.org}/integrations/deliveries/${failSend.json.delivery.id}/retry`, { method: "POST", cookie: state.owner });
  assert.equal(retried.status, 200);
  assert.equal(retried.json.delivery.status, "succeeded");
  assert.equal(retried.json.delivery.attempts, 2);
});

test("embed sessions: only approved origins get tokens; tokens gate the embed APIs", async () => {
  // Unapproved origin → refused.
  const refused = await request("/api/v1/embed/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${state.apiKey}` },
    body: { origin: "https://evil.example.net", modules: ["dashboard"] },
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error.code, "origin_not_approved");

  // Approved origin → short-lived token.
  const issued = await request("/api/v1/embed/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${state.apiKey}` },
    body: { origin: APPROVED_ORIGIN, modules: ["dashboard", "lead_form"], role: "viewer" },
  });
  assert.equal(issued.status, 201, JSON.stringify(issued.json));
  const token = issued.json.data.token;
  assert.ok(new Date(issued.json.data.expires_at) > new Date());

  // Embed API works with the token from the approved origin.
  const metrics = await request("/api/embed/metrics", { headers: { Authorization: `Bearer ${token}`, Origin: APPROVED_ORIGIN } });
  assert.equal(metrics.status, 200, JSON.stringify(metrics.json));
  assert.ok(metrics.json.data.cards, "dashboard metrics payload expected");
  assert.equal(metrics.headers.get("access-control-allow-origin"), APPROVED_ORIGIN);

  // A different origin than the token claim is rejected.
  const wrongOrigin = await request("/api/embed/metrics", { headers: { Authorization: `Bearer ${token}`, Origin: "https://evil.example.net" } });
  assert.equal(wrongOrigin.status, 403);

  // Module claims are enforced: this token has no "appointments" module.
  const noModule = await request("/api/embed/appointments", { headers: { Authorization: `Bearer ${token}`, Origin: APPROVED_ORIGIN } });
  assert.equal(noModule.status, 403);

  // The lead_form module accepts a lead through the widget API.
  const widgetLead = await request("/api/embed/leads", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Origin: APPROVED_ORIGIN },
    body: { firstName: "Widget", email: `widget-${RUN}@rescue-papi-test.local` },
  });
  assert.equal(widgetLead.status, 201, JSON.stringify(widgetLead.json));

  // No token at all → 401.
  const anonymous = await request("/api/embed/metrics", { headers: { Origin: APPROVED_ORIGIN } });
  assert.equal(anonymous.status, 401);

  // Every advertised module maps to a working page + API for a token scoped to just that module.
  const moduleMatrix = [
    { module: "dashboard", page: "/embed/dashboard", api: "/api/embed/metrics", method: "GET" },
    { module: "leads", page: "/embed/leads", api: "/api/embed/leads", method: "GET" },
    { module: "appointments", page: "/embed/appointments", api: "/api/embed/appointments", method: "GET" },
  ];
  for (const entry of moduleMatrix) {
    const session = await request("/api/v1/embed/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${state.apiKey}` },
      body: { origin: APPROVED_ORIGIN, modules: [entry.module] },
    });
    assert.equal(session.status, 201, `${entry.module}: ${JSON.stringify(session.json)}`);
    const scopedToken = session.json.data.token;

    const pageRes = await fetch(`${BASE}${entry.page}?token=${encodeURIComponent(scopedToken)}`, { redirect: "manual" });
    assert.equal(pageRes.status, 200, `${entry.page} must render`);

    const apiRes = await request(entry.api, { headers: { Authorization: `Bearer ${scopedToken}`, Origin: APPROVED_ORIGIN } });
    assert.equal(apiRes.status, 200, `${entry.module} token must access ${entry.api}: ${JSON.stringify(apiRes.json)}`);

    // The same token must NOT reach the other modules' APIs.
    for (const other of moduleMatrix.filter((m) => m.module !== entry.module)) {
      const denied = await request(other.api, { headers: { Authorization: `Bearer ${scopedToken}`, Origin: APPROVED_ORIGIN } });
      assert.equal(denied.status, 403, `${entry.module} token must be denied on ${other.api}`);
    }
  }
  // The loader script routes each module to its own page.
  const loader = await fetch(`${BASE}/embed/v1/loader.js`);
  const loaderSource = await loader.text();
  assert.ok(loaderSource.includes('leads: "/embed/leads"'), "loader must route the leads module to its own page");
  assert.ok(loaderSource.includes('appointments: "/embed/appointments"'), "loader must route the appointments module to its own page");

  // The embed page itself gets frame-ancestors CSP bound to the token's origin.
  const page = await fetch(`${BASE}/embed/dashboard?token=${encodeURIComponent(token)}`, { redirect: "manual" });
  const csp = page.headers.get("content-security-policy") ?? "";
  assert.ok(csp.includes(`frame-ancestors 'self' ${APPROVED_ORIGIN}`), `CSP should pin the approved origin, got: ${csp}`);
  const noTokenPage = await fetch(`${BASE}/embed/dashboard`, { redirect: "manual" });
  assert.ok((noTokenPage.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'"), "no valid token → not frameable");
});
