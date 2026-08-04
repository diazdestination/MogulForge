/**
 * Integration tests for the per-connection CRM push delivery log — over live
 * HTTP against the dev server and the real database:
 * - every outbound lead push (success and failure) lands in the delivery log
 * - the deliveries endpoint lists rows per connection with lead names
 * - a failed delivery can be retried and flips to succeeded once the receiver recovers
 * - retrying an already-succeeded delivery is rejected (no duplicate contacts)
 * - repeated consecutive failures flip the connection status to 'error',
 *   and a successful retry restores it to 'active'
 *
 * Requires the dev server on port 5000, DATABASE_URL, and ADMIN_PASSWORD.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import pg from "pg";

const BASE = process.env.TEST_BASE_URL ?? "http://127.0.0.1:5000";
const RUN = `crmdel${Date.now().toString(36)}`;
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
  return { status: response.status, json, cookie: sessionCookie };
}

const state = { failMode: false };
let receiver;
let receiverPort;

async function cleanup() {
  await db.query("DELETE FROM organizations WHERE slug LIKE 'test-crmdel%'");
  await db.query("DELETE FROM users WHERE email LIKE '%@rescue-crmdel-test.local'");
}

async function createLead(firstName) {
  const res = await request(`/api/v1/leads`, {
    method: "POST",
    headers: { Authorization: `Bearer ${state.apiKey}` },
    body: { firstName, lastName: "Delivery", email: `${firstName.toLowerCase()}-${RUN}@example.com` },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

async function waitForDeliveries(predicate, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    const res = await request(`/api/orgs/${state.org}/integrations/crm/${state.conn}/deliveries`, { cookie: state.owner });
    assert.equal(res.status, 200);
    if (predicate(res.json.deliveries)) return res.json.deliveries;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Expected deliveries never appeared");
}

before(async () => {
  await db.connect();
  await cleanup();

  receiver = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (state.failMode) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end('{"error":"simulated CRM outage"}');
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      }
    });
  });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  receiverPort = receiver.address().port;

  assert.ok(process.env.ADMIN_PASSWORD, "ADMIN_PASSWORD must be set for tests");
  const adminLogin = await request("/api/admin/session", { method: "POST", body: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(adminLogin.status, 200);
  state.admin = adminLogin.cookie;

  const provision = await request("/api/admin/organizations", {
    method: "POST",
    cookie: adminLogin.cookie,
    body: {
      name: `Test ${RUN} Deliveries`,
      slug: `test-${RUN}`,
      plan: "growth",
      modules: ["revenue_rescue", "lead_import", "api_access"],
      usageLimits: { seats: 5 },
      owner: { email: `owner-${RUN}@rescue-crmdel-test.local`, name: "Owner" },
    },
  });
  assert.equal(provision.status, 201, JSON.stringify(provision.json));
  state.org = provision.json.organizationId;

  const accept = await request("/api/invites/accept", {
    method: "POST",
    body: { token: provision.json.inviteToken, name: "Owner", password: "password-crmdel-123" },
  });
  assert.equal(accept.status, 200);
  state.owner = accept.cookie;

  // Generic webhook connection against the local receiver — fully observable.
  const created = await request(`/api/orgs/${state.org}/integrations/crm`, {
    method: "POST",
    cookie: state.owner,
    body: { provider: "generic_webhook", name: "Local CRM", config: { url: `http://127.0.0.1:${receiverPort}/crm` } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  state.conn = created.json.connection.id;

  const mapped = await request(`/api/orgs/${state.org}/integrations/crm/${state.conn}`, {
    method: "PATCH",
    cookie: state.owner,
    body: { fieldMapping: [{ source: "firstName", target: "first_name", transform: "none" }, { source: "email", target: "email", transform: "lowercase" }] },
  });
  assert.equal(mapped.status, 200);
  const tested = await request(`/api/orgs/${state.org}/integrations/crm/${state.conn}/test`, { method: "POST", cookie: state.owner });
  assert.equal(tested.json.result.ok, true);
  const activated = await request(`/api/orgs/${state.org}/integrations/crm/${state.conn}`, {
    method: "PATCH",
    cookie: state.owner,
    body: { status: "active" },
  });
  assert.equal(activated.status, 200);

  const keyRes = await request(`/api/orgs/${state.org}/integrations/api-keys`, {
    method: "POST",
    cookie: state.owner,
    body: { name: "Deliveries test", scopes: ["leads:write"] },
  });
  assert.equal(keyRes.status, 201);
  state.apiKey = keyRes.json.rawKey;
});

after(async () => {
  await new Promise((resolve) => receiver.close(resolve));
  await cleanup();
  await db.end();
});

test("successful push is recorded in the delivery log with the lead name", async () => {
  await createLead("Sunny");
  const deliveries = await waitForDeliveries((rows) => rows.some((d) => d.status === "succeeded"));
  const ok = deliveries.find((d) => d.status === "succeeded");
  assert.equal(ok.leadName, "Sunny Delivery");
  assert.equal(ok.lastStatusCode, 200);
  assert.equal(ok.lastError, null);
  assert.ok(ok.deliveredAt);
});

test("failed push is recorded with the error, and retry succeeds after recovery", async () => {
  state.failMode = true;
  await createLead("Rocky");
  const deliveries = await waitForDeliveries((rows) => rows.some((d) => d.status === "failed"));
  const failed = deliveries.find((d) => d.status === "failed");
  assert.equal(failed.leadName, "Rocky Delivery");
  assert.equal(failed.lastStatusCode, 500);
  assert.ok(failed.lastError, "failed delivery must carry an error message");

  // Retry while still failing: stays failed and reports the error honestly.
  const retryFail = await request(`/api/orgs/${state.org}/integrations/crm/${state.conn}/deliveries/${failed.id}/retry`, {
    method: "POST",
    cookie: state.owner,
  });
  assert.equal(retryFail.status, 200);
  assert.equal(retryFail.json.delivery.status, "failed");
  assert.equal(retryFail.json.delivery.attempts, 2);
  assert.ok(retryFail.json.error);

  // Receiver recovers → retry flips the same row to succeeded.
  state.failMode = false;
  const retryOk = await request(`/api/orgs/${state.org}/integrations/crm/${state.conn}/deliveries/${failed.id}/retry`, {
    method: "POST",
    cookie: state.owner,
  });
  assert.equal(retryOk.status, 200);
  assert.equal(retryOk.json.delivery.status, "succeeded");
  assert.equal(retryOk.json.delivery.attempts, 3);
  assert.ok(retryOk.json.delivery.deliveredAt);

  // Retrying a succeeded delivery is rejected — no duplicate CRM contacts.
  const retryAgain = await request(`/api/orgs/${state.org}/integrations/crm/${state.conn}/deliveries/${failed.id}/retry`, {
    method: "POST",
    cookie: state.owner,
  });
  assert.equal(retryAgain.status, 200);
  assert.ok(retryAgain.json.error);
  assert.equal(retryAgain.json.delivery.attempts, 3);
});

test("retry under a mismatched connection is rejected before any side effect", async () => {
  state.failMode = true;
  await createLead("Scopey");
  const deliveries = await waitForDeliveries((rows) => rows.some((d) => d.status === "failed" && d.leadName === "Scopey Delivery"));
  const failed = deliveries.find((d) => d.leadName === "Scopey Delivery");
  state.failMode = false;

  // A second connection in the same org — its route must not be able to retry the first connection's delivery.
  const other = await request(`/api/orgs/${state.org}/integrations/crm`, {
    method: "POST",
    cookie: state.owner,
    body: { provider: "generic_webhook", name: "Other CRM", config: { url: `http://127.0.0.1:${receiverPort}/other` } },
  });
  assert.equal(other.status, 201);
  const mismatched = await request(
    `/api/orgs/${state.org}/integrations/crm/${other.json.connection.id}/deliveries/${failed.id}/retry`,
    { method: "POST", cookie: state.owner },
  );
  assert.equal(mismatched.status, 404);

  // The delivery is untouched: still failed, no extra attempt was made.
  const after = await request(`/api/orgs/${state.org}/integrations/crm/${state.conn}/deliveries`, { cookie: state.owner });
  const unchanged = after.json.deliveries.find((d) => d.id === failed.id);
  assert.equal(unchanged.status, "failed");
  assert.equal(unchanged.attempts, failed.attempts);
});

test("repeated failures flip the connection to 'error'; a successful retry restores it", async () => {
  state.failMode = true;
  // Threshold is 5 consecutive failures.
  for (const name of ["Fail1", "Fail2", "Fail3", "Fail4", "Fail5"]) {
    await createLead(name);
  }
  let connection;
  for (let i = 0; i < 40; i++) {
    const list = await request(`/api/orgs/${state.org}/integrations/crm`, { cookie: state.owner });
    connection = list.json.connections.find((c) => c.id === state.conn);
    if (connection.status === "error") break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(connection.status, "error", "connection should flip to error after repeated failures");

  // Fix the receiver and retry one failed delivery — the connection recovers.
  state.failMode = false;
  const deliveries = await waitForDeliveries((rows) => rows.some((d) => d.status === "failed"));
  const failed = deliveries.find((d) => d.status === "failed");
  const retried = await request(`/api/orgs/${state.org}/integrations/crm/${state.conn}/deliveries/${failed.id}/retry`, {
    method: "POST",
    cookie: state.owner,
  });
  assert.equal(retried.json.delivery.status, "succeeded");
  const list = await request(`/api/orgs/${state.org}/integrations/crm`, { cookie: state.owner });
  assert.equal(list.json.connections.find((c) => c.id === state.conn).status, "active");
});

// --- Automatic retry of failed pushes (background processor) ---

/** Backdates a delivery's next_attempt_at so the processor sees it as due now. */
async function makeDue(deliveryId) {
  await db.query(`UPDATE crm_push_deliveries SET next_attempt_at = now() - interval '1 minute' WHERE id = $1`, [deliveryId]);
}

/** Runs the background processor via the cron route (admin-authenticated). */
async function runCronPass() {
  const res = await request("/api/cron/webhook-deliveries", { method: "POST", cookie: state.admin });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json;
}

test("failed push is scheduled for automatic retry and recovers without a manual click", async () => {
  state.failMode = true;
  await createLead("Auto");
  const deliveries = await waitForDeliveries((rows) => rows.some((d) => d.leadName === "Auto Delivery" && d.status === "failed"));
  const failed = deliveries.find((d) => d.leadName === "Auto Delivery");
  // The failed row got a backoff schedule at insert time.
  const { rows } = await db.query(`SELECT next_attempt_at FROM crm_push_deliveries WHERE id = $1`, [failed.id]);
  assert.ok(rows[0].next_attempt_at, "failed delivery must have next_attempt_at set");

  // CRM recovers; once the backoff elapses the processor re-pushes it automatically.
  state.failMode = false;
  await makeDue(failed.id);
  await runCronPass();
  const after = await request(`/api/orgs/${state.org}/integrations/crm/${state.conn}/deliveries`, { cookie: state.owner });
  const recovered = after.json.deliveries.find((d) => d.id === failed.id);
  assert.equal(recovered.status, "succeeded");
  assert.equal(recovered.attempts, failed.attempts + 1);
  const cleared = await db.query(`SELECT next_attempt_at FROM crm_push_deliveries WHERE id = $1`, [failed.id]);
  assert.equal(cleared.rows[0].next_attempt_at, null, "success must clear the retry schedule");
});

test("automatic retries skip deliveries on non-active connections", async () => {
  state.failMode = true;
  await createLead("Paused");
  const deliveries = await waitForDeliveries((rows) => rows.some((d) => d.leadName === "Paused Delivery" && d.status === "failed"));
  const failed = deliveries.find((d) => d.leadName === "Paused Delivery");
  state.failMode = false;

  await db.query(`UPDATE crm_connections SET status = 'disabled' WHERE id = $1`, [state.conn]);
  try {
    await makeDue(failed.id);
    await runCronPass();
    const { rows } = await db.query(`SELECT status, attempts FROM crm_push_deliveries WHERE id = $1`, [failed.id]);
    assert.equal(rows[0].status, "failed", "delivery on a disabled connection must not be retried");
    assert.equal(Number(rows[0].attempts), failed.attempts);
  } finally {
    await db.query(`UPDATE crm_connections SET status = 'active', push_failure_count = 0 WHERE id = $1`, [state.conn]);
  }

  // Once the connection is active again, the still-due delivery recovers.
  await runCronPass();
  const { rows } = await db.query(`SELECT status FROM crm_push_deliveries WHERE id = $1`, [failed.id]);
  assert.equal(rows[0].status, "succeeded");
});

test("automatic retries stop once attempts are exhausted", async () => {
  state.failMode = true;
  await createLead("Exhaust");
  const deliveries = await waitForDeliveries((rows) => rows.some((d) => d.leadName === "Exhaust Delivery" && d.status === "failed"));
  const failed = deliveries.find((d) => d.leadName === "Exhaust Delivery");

  // Simulate being one attempt away from the cap (backoff schedule has 5 steps + initial attempt).
  await db.query(`UPDATE crm_push_deliveries SET attempts = 5, next_attempt_at = now() - interval '1 minute' WHERE id = $1`, [failed.id]);
  await runCronPass();
  const { rows } = await db.query(`SELECT status, attempts, next_attempt_at FROM crm_push_deliveries WHERE id = $1`, [failed.id]);
  assert.equal(rows[0].status, "failed");
  assert.equal(Number(rows[0].attempts), 6);
  assert.equal(rows[0].next_attempt_at, null, "exhausted delivery must not be rescheduled");

  // With no schedule left, another pass does nothing.
  await runCronPass();
  const again = await db.query(`SELECT attempts FROM crm_push_deliveries WHERE id = $1`, [failed.id]);
  assert.equal(Number(again.rows[0].attempts), 6);

  // Leave the receiver healthy and reset the failure counter for any later tests.
  state.failMode = false;
  await db.query(`UPDATE crm_connections SET status = 'active', push_failure_count = 0 WHERE id = $1`, [state.conn]);
});
