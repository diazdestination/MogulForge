/**
 * Usage metering, plan limits & white-label integration tests.
 *
 * Runs against the live dev server (default http://127.0.0.1:5000) over real
 * HTTP: plan-limit gates on imports, 75/90/100 warning surfacing, the
 * never-block exemptions (suppression/opt-out + account-closure export),
 * suspended-account blocking, white-label entitlement enforcement, and usage
 * rollup accuracy. Requires DATABASE_URL and ADMIN_PASSWORD in the env.
 *
 *   npm test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import pg from "pg";

const BASE = process.env.TEST_BASE_URL ?? "http://127.0.0.1:5000";
const RUN = `ub${Date.now().toString(36)}`;
const APPROVED_ORIGIN = "https://client.example.com";
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

async function request(path, { method = "GET", body, cookie, form, headers = {} } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: form ?? (body ? JSON.stringify(body) : undefined),
    redirect: "manual",
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  const sessionCookie = setCookie.map((c) => c.split(";")[0]).join("; ") || null;
  const contentType = response.headers.get("content-type") ?? "";
  let json = null;
  let text = null;
  if (contentType.includes("application/json")) json = await response.json().catch(() => null);
  else text = await response.text().catch(() => null);
  return { status: response.status, json, text, cookie: sessionCookie };
}

function csvFile(name, rows) {
  const content = ["First Name,Last Name,Email,Phone", ...rows].join("\n");
  const form = new FormData();
  form.append("file", new File([content], name, { type: "text/csv" }));
  return form;
}

function leadRows(count, tag) {
  return Array.from({ length: count }, (_, i) => `Lead,${tag}${i},${tag}${i}-${RUN}@usage-test.local,`);
}

async function pollImport(orgId, importId, cookie, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request(`/api/orgs/${orgId}/imports/${importId}`, { cookie });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const record = res.json.import;
    if (["complete", "failed", "partial"].includes(record.status)) return record;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Import did not reach a terminal status in time.");
}

async function confirmMapping(orgId, importId, cookie) {
  const res = await request(`/api/orgs/${orgId}/imports/${importId}/mapping`, {
    method: "POST",
    cookie,
    body: { mapping: { "First Name": "firstName", "Last Name": "lastName", "Email": "email", "Phone": "phone" } },
  });
  return res;
}

async function getUsage(orgId, cookie) {
  const res = await request(`/api/orgs/${orgId}/usage`, { cookie });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json.usage;
}

function usageLine(usage, metric) {
  return usage.lines.find((line) => line.metric === metric);
}

/** Polls the usage API until a metric reaches `expected` (background recording is async). */
async function pollUsageValue(orgId, cookie, metric, expected, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const usage = await getUsage(orgId, cookie);
    last = usageLine(usage, metric)?.used ?? null;
    if (last === expected) return last;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return last;
}

/** Sends a signed incoming webhook event (same HMAC scheme as production senders). */
async function sendIncoming(token, secret, event) {
  const rawBody = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const signature = `v1=${createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex")}`;
  const response = await fetch(`${BASE}/api/webhooks/incoming/${token}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-RevenueRescue-Timestamp": String(ts),
      "X-RevenueRescue-Signature": signature,
    },
    body: rawBody,
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}

const state = {};

async function cleanup() {
  await db.query("DELETE FROM organizations WHERE slug LIKE 'test-ub%'");
  await db.query("DELETE FROM users WHERE email LIKE '%@usage-test.local'");
}

before(async () => {
  await db.connect();
  await cleanup();

  assert.ok(process.env.ADMIN_PASSWORD, "ADMIN_PASSWORD must be set for tests");
  const adminLogin = await request("/api/admin/session", { method: "POST", body: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(adminLogin.status, 200);
  state.adminCookie = adminLogin.cookie;

  const provision = await request("/api/admin/organizations", {
    method: "POST",
    cookie: state.adminCookie,
    body: {
      name: `Test ${RUN} Usage`,
      slug: `test-${RUN}`,
      plan: "growth",
      modules: ["revenue_rescue", "lead_import", "email_campaigns", "api_access"],
      usageLimits: { seats: 5, leads_imported: 5, leads_stored: 50 },
      allowedOrigins: [APPROVED_ORIGIN],
      owner: { email: `owner-${RUN}@usage-test.local`, name: "Owner" },
    },
  });
  assert.equal(provision.status, 201, JSON.stringify(provision.json));
  state.org = provision.json.organizationId;

  const accept = await request("/api/invites/accept", {
    method: "POST",
    body: { token: provision.json.inviteToken, name: "Owner", password: "password-ub-123" },
  });
  assert.equal(accept.status, 200);
  state.owner = accept.cookie;

  // A user with no membership in the org, for access-control checks.
  const outsider = await request("/api/auth/register", {
    method: "POST",
    body: { email: `outsider-${RUN}@usage-test.local`, name: "Outsider", password: "password-out-123" },
  });
  assert.equal(outsider.status, 201);
  state.outsider = outsider.cookie;
});

after(async () => {
  await cleanup();
  await db.end();
});

// ---------------------------------------------------------------------------
// Limit gates + rollup accuracy
// ---------------------------------------------------------------------------

test("over-limit import upload is blocked server-side with usage_limit_reached", async () => {
  const res = await request(`/api/orgs/${state.org}/imports`, {
    method: "POST",
    cookie: state.owner,
    form: csvFile("too-big.csv", leadRows(10, "big")),
  });
  assert.equal(res.status, 403, JSON.stringify(res.json));
  assert.equal(res.json.code, "usage_limit_reached");
});

test("within-limit import runs and usage rolls up accurately", async () => {
  const upload = await request(`/api/orgs/${state.org}/imports`, {
    method: "POST",
    cookie: state.owner,
    form: csvFile("first.csv", leadRows(3, "first")),
  });
  assert.equal(upload.status, 201, JSON.stringify(upload.json));
  const confirm = await confirmMapping(state.org, upload.json.import.id, state.owner);
  assert.equal(confirm.status, 200, JSON.stringify(confirm.json));
  const record = await pollImport(state.org, upload.json.import.id, state.owner);
  assert.equal(record.status, "complete", JSON.stringify(record));

  const usage = await getUsage(state.org, state.owner);
  assert.equal(usageLine(usage, "leads_imported").used, 3);
  assert.equal(usageLine(usage, "leads_imported").limit, 5);
  assert.equal(usageLine(usage, "leads_stored").used, 3); // live gauge = stored leads
  state.firstImportLeads = 3;
});

test("dashboard visits record active users for the period", async () => {
  // Active users are metered on dashboard access (not raw API calls).
  const page = await request(`/dashboard/revenue-rescue?org=${state.org}`, { cookie: state.owner });
  assert.ok([200, 307].includes(page.status), `dashboard → ${page.status}`);
  // Recording is fire-and-forget; poll briefly for the rollup.
  const deadline = Date.now() + 10000;
  let active = 0;
  while (Date.now() < deadline) {
    const usage = await getUsage(state.org, state.owner);
    active = usageLine(usage, "active_users").used;
    if (active >= 1) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(active >= 1, `active_users should be ≥ 1, got ${active}`);
});

test("reaching 100% of a limit surfaces a warning and blocks further imports", async () => {
  const upload = await request(`/api/orgs/${state.org}/imports`, {
    method: "POST",
    cookie: state.owner,
    form: csvFile("second.csv", leadRows(2, "second")),
  });
  assert.equal(upload.status, 201, JSON.stringify(upload.json));
  const confirm = await confirmMapping(state.org, upload.json.import.id, state.owner);
  assert.equal(confirm.status, 200, JSON.stringify(confirm.json));
  const record = await pollImport(state.org, upload.json.import.id, state.owner);
  assert.equal(record.status, "complete", JSON.stringify(record));

  const usage = await getUsage(state.org, state.owner);
  assert.equal(usageLine(usage, "leads_imported").used, 5);
  assert.equal(usageLine(usage, "leads_imported").warning, 100);
  assert.equal(
    usage.warnings.some((w) => w.metric === "leads_imported" && w.warning === 100),
    true,
    JSON.stringify(usage.warnings),
  );

  // Persistent warning record exists (100 crossing, plus 75/90 crossed on the way).
  const { rows } = await db.query(
    "SELECT threshold FROM usage_warnings WHERE organization_id = $1 AND metric = 'leads_imported' ORDER BY threshold",
    [state.org],
  );
  assert.equal(rows.some((r) => Number(r.threshold) === 100), true, JSON.stringify(rows));

  // One more row must now be rejected.
  const blocked = await request(`/api/orgs/${state.org}/imports`, {
    method: "POST",
    cookie: state.owner,
    form: csvFile("blocked.csv", leadRows(1, "blocked")),
  });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.code, "usage_limit_reached");
});

// ---------------------------------------------------------------------------
// Never-block exemptions
// ---------------------------------------------------------------------------

test("suppression/opt-out processing still works at 100% usage", async () => {
  const leads = await request(`/api/orgs/${state.org}/leads?limit=5`, { cookie: state.owner });
  assert.equal(leads.status, 200);
  const lead = leads.json.leads[0];
  assert.ok(lead, "expected an imported lead");
  state.leadId = lead.id;

  const suppress = await request(`/api/orgs/${state.org}/leads/${lead.id}`, {
    method: "PATCH",
    cookie: state.owner,
    body: { action: "suppress", reason: "Customer opted out", optOut: true },
  });
  assert.equal(suppress.status, 200, JSON.stringify(suppress.json));
});

test("suspended account blocks gated actions but never suppression or export", async () => {
  await db.query("UPDATE org_subscriptions SET status = 'suspended' WHERE organization_id = $1", [state.org]);

  // Gated action → account_blocked (even though this upload is tiny).
  const upload = await request(`/api/orgs/${state.org}/imports`, {
    method: "POST",
    cookie: state.owner,
    form: csvFile("suspended.csv", leadRows(1, "susp")),
  });
  assert.equal(upload.status, 403, JSON.stringify(upload.json));
  assert.equal(upload.json.code, "account_blocked");

  // Suppression still works while suspended.
  const leads = await request(`/api/orgs/${state.org}/leads?limit=5`, { cookie: state.owner });
  const other = leads.json.leads.find((l) => l.id !== state.leadId);
  assert.ok(other, "expected a second lead");
  const suppress = await request(`/api/orgs/${state.org}/leads/${other.id}`, {
    method: "PATCH",
    cookie: state.owner,
    body: { action: "suppress", reason: "Do not contact", optOut: true },
  });
  assert.equal(suppress.status, 200, JSON.stringify(suppress.json));

  // Account-closure export still works while suspended.
  const exportRes = await request(`/api/orgs/${state.org}/export`, { cookie: state.owner });
  assert.equal(exportRes.status, 200);
  assert.ok(exportRes.text.startsWith("id,first_name"), exportRes.text?.slice(0, 80));
  assert.ok(exportRes.text.includes(`first0-${RUN}@usage-test.local`), "export should contain imported leads");

  await db.query("UPDATE org_subscriptions SET status = 'active' WHERE organization_id = $1", [state.org]);
});

// ---------------------------------------------------------------------------
// White-label entitlement enforcement
// ---------------------------------------------------------------------------

test("white_label settings save but resolve to powered_by without the entitlement", async () => {
  const patch = await request(`/api/orgs/${state.org}/branding`, {
    method: "PATCH",
    cookie: state.owner,
    body: { brandingLevel: "white_label", displayName: "Acme Exteriors", brandPrimaryColor: "#ff6600" },
  });
  assert.equal(patch.status, 200, JSON.stringify(patch.json));
  assert.equal(patch.json.branding.level, "powered_by"); // downgraded at resolution
  assert.equal(patch.json.branding.requestedLevel, "white_label");
  assert.equal(patch.json.branding.poweredBy.show, true);
  assert.equal(patch.json.branding.displayName, "Acme Exteriors");
});

test("granting the white_label entitlement upgrades the resolved level", async () => {
  await db.query(
    `INSERT INTO entitlements (organization_id, feature_key, enabled) VALUES ($1, 'white_label', true)
     ON CONFLICT (organization_id, feature_key) DO UPDATE SET enabled = true`,
    [state.org],
  );
  const res = await request(`/api/orgs/${state.org}/branding`, { cookie: state.owner });
  assert.equal(res.status, 200);
  assert.equal(res.json.whiteLabelEntitled, true);
  assert.equal(res.json.branding.level, "white_label");
  assert.equal(res.json.branding.poweredBy.show, false); // no label set → hidden
});

test("invalid branding values are rejected", async () => {
  const res = await request(`/api/orgs/${state.org}/branding`, {
    method: "PATCH",
    cookie: state.owner,
    body: { brandPrimaryColor: "lime-green" },
  });
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

test("outsiders cannot read usage, branding, or the export", async () => {
  for (const path of [`/api/orgs/${state.org}/usage`, `/api/orgs/${state.org}/branding`, `/api/orgs/${state.org}/export`, `/api/orgs/${state.org}/domains`]) {
    const res = await request(path, { cookie: state.outsider });
    assert.ok([403, 404].includes(res.status), `${path} → ${res.status}`);
  }
});

// ---------------------------------------------------------------------------
// Custom domains
// ---------------------------------------------------------------------------

test("custom domain request stores DNS records; activation is gated on verification", async () => {
  const create = await request(`/api/orgs/${state.org}/domains`, {
    method: "POST",
    cookie: state.owner,
    body: { domain: `portal.test-${RUN}.example.com` },
  });
  assert.equal(create.status, 201, JSON.stringify(create.json));
  const domain = create.json.domain;
  assert.equal(domain.status, "pending_dns");
  assert.equal(domain.requiredDns.length, 2);
  assert.ok(domain.requiredDns.some((r) => r.type === "TXT" && r.name.startsWith("_mogulforge-verify.")));

  // Duplicate request rejected.
  const dup = await request(`/api/orgs/${state.org}/domains`, {
    method: "POST",
    cookie: state.owner,
    body: { domain: `PORTAL.test-${RUN}.example.COM` },
  });
  assert.equal(dup.status, 409, JSON.stringify(dup.json));

  // Verification fails (no real DNS) but is recorded, not thrown.
  const verify = await request(`/api/orgs/${state.org}/domains/${domain.id}`, {
    method: "POST",
    cookie: state.owner,
    body: { action: "verify" },
  });
  assert.equal(verify.status, 200, JSON.stringify(verify.json));
  assert.equal(verify.json.verified, false);

  // Unverified domains can never be activated (DB stays pending).
  const { rows } = await db.query("SELECT status FROM custom_domains WHERE id = $1", [domain.id]);
  assert.equal(rows[0].status, "pending_dns");
});

// ---------------------------------------------------------------------------
// Every lead-creation entry point is gated AND metered consistently
// ---------------------------------------------------------------------------

test("incoming webhook lead.created is blocked at the limit and records nothing", async () => {
  const created = await request(`/api/orgs/${state.org}/integrations/incoming-webhooks`, {
    method: "POST",
    cookie: state.owner,
    body: { name: "Usage test source" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  state.hook = created.json.endpoint; // { token, secret }

  // Org is at 5/5 leads_imported — lead.created must fail, not create.
  const email = `hookblocked-${RUN}@usage-test.local`;
  const res = await sendIncoming(state.hook.token, state.hook.secret, {
    id: `evt-${RUN}-blocked`,
    type: "lead.created",
    data: { email, firstName: "Blocked" },
  });
  assert.equal(res.status, 202, JSON.stringify(res.json));
  assert.equal(res.json.status, "failed", JSON.stringify(res.json));

  const { rows } = await db.query("SELECT count(*)::int AS n FROM rescue_leads WHERE organization_id = $1 AND email_normalized = $2", [state.org, email]);
  assert.equal(rows[0].n, 0, "no lead may be created over the limit");
  const usage = await getUsage(state.org, state.owner);
  assert.equal(usageLine(usage, "leads_imported").used, 5, "usage must not move on a blocked event");
});

test("incoming webhook lead.created is metered once capacity exists", async () => {
  // Raise the override to 7 so exactly two more leads fit (webhook + widget below).
  await db.query(`UPDATE organizations SET usage_limits = usage_limits || '{"leads_imported": 7}'::jsonb WHERE id = $1`, [state.org]);

  const email = `hookok-${RUN}@usage-test.local`;
  const res = await sendIncoming(state.hook.token, state.hook.secret, {
    id: `evt-${RUN}-ok`,
    type: "lead.created",
    data: { email, firstName: "Hooked" },
  });
  assert.equal(res.status, 202, JSON.stringify(res.json));
  assert.equal(res.json.status, "processed", JSON.stringify(res.json));

  assert.equal(await pollUsageValue(state.org, state.owner, "leads_imported", 6), 6, "webhook lead must count toward leads_imported");
  const usage = await getUsage(state.org, state.owner);
  assert.ok(usageLine(usage, "webhook_events").used >= 1, "webhook events are metered");
});

test("embed widget lead capture is metered, then blocked at the limit", async () => {
  const key = await request(`/api/orgs/${state.org}/integrations/api-keys`, {
    method: "POST",
    cookie: state.owner,
    body: { name: "Embed key", scopes: ["embed:write"] },
  });
  assert.equal(key.status, 201, JSON.stringify(key.json));
  const session = await request("/api/v1/embed/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key.json.rawKey}` },
    body: { origin: APPROVED_ORIGIN, modules: ["lead_form"] },
  });
  assert.equal(session.status, 201, JSON.stringify(session.json));
  const token = session.json.data.token;
  const embedHeaders = { Authorization: `Bearer ${token}`, Origin: APPROVED_ORIGIN };

  // 6/7 used — one widget lead fits and is metered.
  const ok = await request("/api/embed/leads", {
    method: "POST",
    headers: embedHeaders,
    body: { firstName: "Widget", email: `widget-${RUN}@usage-test.local` },
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(await pollUsageValue(state.org, state.owner, "leads_imported", 7), 7, "widget lead must count toward leads_imported");

  // 7/7 — the next capture is refused server-side and creates nothing.
  const blockedEmail = `widgetblocked-${RUN}@usage-test.local`;
  const blocked = await request("/api/embed/leads", {
    method: "POST",
    headers: embedHeaders,
    body: { firstName: "Blocked", email: blockedEmail },
  });
  assert.equal(blocked.status, 403, JSON.stringify(blocked.json));
  assert.equal(blocked.json.error.code, "usage_limit_reached");
  const { rows } = await db.query("SELECT count(*)::int AS n FROM rescue_leads WHERE organization_id = $1 AND email_normalized = $2", [state.org, blockedEmail]);
  assert.equal(rows[0].n, 0);
});

test("account-closure export neutralizes spreadsheet formula payloads", async () => {
  // A hostile lead value that Excel/Sheets would execute as a formula.
  const { rows } = await db.query(
    "SELECT id FROM rescue_leads WHERE organization_id = $1 ORDER BY created_at ASC LIMIT 1",
    [state.org],
  );
  assert.ok(rows[0], "expected a lead to poison");
  await db.query(`UPDATE rescue_leads SET notes = '=HYPERLINK("http://evil.example/x","click")' WHERE id = $1`, [rows[0].id]);

  const exportRes = await request(`/api/orgs/${state.org}/export`, { cookie: state.owner });
  assert.equal(exportRes.status, 200);
  assert.ok(exportRes.text.includes("'=HYPERLINK"), "formula cells must be neutralized with a leading quote");
  // No cell may start with an executable formula character: not at the start
  // of a line, not after a separator, and not as a quoted cell opening.
  assert.ok(!exportRes.text.startsWith("="), "first cell must not be an executable formula");
  assert.ok(!/[,\r\n]=/.test(exportRes.text), "no unquoted cell may start with =");
  assert.ok(!/(^|[,\r\n])"=/.test(exportRes.text), "no quoted cell may start with =");
});

test("intake-wizard file upload is gated by the same import limits", async () => {
  // The owner's org is at its leads_imported limit — the intake path must not
  // be a bypass around the org-scoped import gates.
  const intake = {
    company: { name: `Test ${RUN} Usage`, website: "", industry: "Roofing", serviceArea: "Toledo, OH", averageJobValue: 9000 },
    leadSources: { sources: ["crm_export"], estimatedDormantLeads: 50, notes: "" },
    campaignPreferences: { channels: ["email"], tone: "professional", approveBeforeSending: true },
    confirmations: { ownsData: true, hasContactPermission: true, honorsOptOuts: true },
  };
  const form = new FormData();
  form.append("intake", JSON.stringify(intake));
  form.append("file", new File([`Email\nintakeblocked-${RUN}@usage-test.local`], "intake.csv", { type: "text/csv" }));
  form.append("mapping", JSON.stringify({ Email: "email" }));
  const res = await request("/api/revenue-rescue/intake", { method: "POST", cookie: state.owner, form });
  assert.equal(res.status, 403, JSON.stringify(res.json));
  assert.equal(res.json.code, "usage_limit_reached");
  const { rows } = await db.query("SELECT count(*)::int AS n FROM rescue_leads WHERE organization_id = $1 AND email_normalized = $2", [state.org, `intakeblocked-${RUN}@usage-test.local`]);
  assert.equal(rows[0].n, 0);
});

test("post-import auto-analysis is blocked when the AI-job limit is exhausted", async () => {
  // Give the org the AI module but zero AI-job capacity, plus room to import.
  await db.query(
    `INSERT INTO entitlements (organization_id, feature_key, enabled) VALUES ($1, 'ai_analysis', true)
     ON CONFLICT (organization_id, feature_key) DO UPDATE SET enabled = true`,
    [state.org],
  );
  await db.query(`UPDATE organizations SET usage_limits = usage_limits || '{"ai_jobs": 0, "leads_imported": 12}'::jsonb WHERE id = $1`, [state.org]);

  const upload = await request(`/api/orgs/${state.org}/imports`, {
    method: "POST",
    cookie: state.owner,
    form: csvFile("auto-analysis.csv", leadRows(2, "auto")),
  });
  assert.equal(upload.status, 201, JSON.stringify(upload.json));
  const confirm = await confirmMapping(state.org, upload.json.import.id, state.owner);
  assert.equal(confirm.status, 200, JSON.stringify(confirm.json));
  const record = await pollImport(state.org, upload.json.import.id, state.owner);
  assert.equal(record.status, "complete", JSON.stringify(record));

  // The import itself succeeded, but no analysis run may have started.
  const runs = await db.query("SELECT count(*)::int AS n FROM lead_analysis_runs WHERE organization_id = $1", [state.org]);
  assert.equal(runs.rows[0].n, 0, "auto-start must respect the ai_jobs limit");
  const pending = await db.query(
    "SELECT count(*)::int AS n FROM rescue_leads WHERE organization_id = $1 AND analysis_status = 'pending' AND email_normalized LIKE $2",
    [state.org, `auto%-${RUN}@usage-test.local`],
  );
  assert.equal(pending.rows[0].n, 2, "imported leads stay pending instead of being analyzed");
  const usage = await getUsage(state.org, state.owner);
  assert.equal(usageLine(usage, "ai_jobs").used, 0, "no AI job may be metered when blocked");

  // The manual start path reports the same block explicitly.
  const manual = await request(`/api/orgs/${state.org}/analysis`, { method: "POST", cookie: state.owner, body: {} });
  assert.equal(manual.status, 403, JSON.stringify(manual.json));
  assert.equal(manual.json.code, "usage_limit_reached");
});

// ---------------------------------------------------------------------------
// Campaign activation is quantity-aware
// ---------------------------------------------------------------------------

test("campaign activation checks capacity for the whole audience, not one send", async () => {
  const created = await request(`/api/orgs/${state.org}/campaigns`, {
    method: "POST",
    cookie: state.owner,
    body: { name: `Usage gate ${RUN}`, channel: "email", tone: "professional" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const campaignId = created.json.campaign.id;

  const preview = await request(`/api/orgs/${state.org}/campaigns/${campaignId}/preview`, { cookie: state.owner });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  const eligible = preview.json.accounting.eligible;
  assert.ok(eligible >= 2, `need at least 2 eligible leads to prove the gate is quantity-aware, got ${eligible}`);

  // Leave room for exactly eligible-1 sends: a per-send gate would let this
  // activation through and overshoot the plan; the quantity-aware gate must refuse.
  await db.query(`UPDATE organizations SET usage_limits = usage_limits || $2::jsonb WHERE id = $1`, [state.org, JSON.stringify({ emails_sent: eligible - 1 })]);
  const blocked = await request(`/api/orgs/${state.org}/campaigns/${campaignId}/activate`, {
    method: "POST",
    cookie: state.owner,
    body: { mode: "simulation", confirm: true },
  });
  assert.equal(blocked.status, 403, JSON.stringify(blocked.json));
  assert.equal(blocked.json.code, "usage_limit_reached");
  const { rows } = await db.query("SELECT count(*)::int AS n FROM rescue_messages WHERE organization_id = $1", [state.org]);
  assert.equal(rows[0].n, 0, "a blocked activation must not send anything");

  // With capacity for the full audience, activation succeeds and sends are metered.
  await db.query(`UPDATE organizations SET usage_limits = usage_limits || '{"emails_sent": 100}'::jsonb WHERE id = $1`, [state.org]);
  const activated = await request(`/api/orgs/${state.org}/campaigns/${campaignId}/activate`, {
    method: "POST",
    cookie: state.owner,
    body: { mode: "simulation", confirm: true },
  });
  assert.equal(activated.status, 200, JSON.stringify(activated.json));
  assert.equal(activated.json.simulatedSends, eligible, "all eligible leads get the (simulated) first touch");
  assert.equal(
    await pollUsageValue(state.org, state.owner, "emails_sent", eligible),
    eligible,
    "simulated sends must be metered against emails_sent",
  );
});
