/**
 * End-to-end lead-import pipeline tests.
 *
 * Runs against the live dev server (default http://127.0.0.1:5000) over real
 * HTTP: upload → auto-mapping → mapping confirmation → staged pipeline →
 * dedupe / suppression enforcement → rejected-row export → safe retry →
 * self-serve intake. Requires DATABASE_URL and ADMIN_PASSWORD in the env.
 *
 *   npm test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const BASE = process.env.TEST_BASE_URL ?? "http://127.0.0.1:5000";
const RUN = `ri${Date.now().toString(36)}`;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

async function request(path, { method = "GET", body, cookie, form } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
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

function csvFile(name, content) {
  const form = new FormData();
  form.append("file", new File([content], name, { type: "text/csv" }));
  return form;
}

async function pollImport(orgId, importId, cookie, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request(`/api/orgs/${orgId}/imports/${importId}`, { cookie });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const record = res.json.import;
    if (["complete", "failed", "partial", "mapping_required"].includes(record.status)) return record;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Import did not reach a terminal status in time.");
}

const LEADS_CSV = [
  "First Name,Last Name,Email,Phone,Estimate Amount,Lead ID,Consent,Notes",
  `Maria,Lopez,maria-${RUN}@rescue-test.local,(555) 201-7788,"$18,500",L-1,yes,quoted after storm`,
  `James,Carter,james-${RUN}@rescue-test.local,555-318-2244,3200,L-2,,estimate sent`,
  `Maria2,Lopez,maria-${RUN}@rescue-test.local,555-999-0000,1000,L-3,,dup email in file`,
  `Xavier,Young,unique1-${RUN}@rescue-test.local,555-222-3333,500,L-1,,dup external id`,
  `"=CMD|' /C calc'!A0",NoContact,,,100,L-5,,invalid row with formula payload`,
  `Dana,Whitfield,dana-${RUN}@rescue-test.local,555-443-0912,7400,L-6,opted_out,asked to stop texts`,
  `Sam,Seeded,suppressed-${RUN}@rescue-test.local,555-777-8888,900,L-7,,already on DNC list`,
  `,,,(555) 605-1212,250,L-8,,phone-only row`,
].join("\n");

const state = {};

async function cleanup() {
  await db.query("DELETE FROM organizations WHERE slug LIKE 'test-ri%' OR slug LIKE 'rescue-intake-co%'");
  await db.query("DELETE FROM users WHERE email LIKE '%@rescue-test.local'");
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
      name: `Test ${RUN} Imports`,
      slug: `test-${RUN}`,
      plan: "growth",
      modules: ["revenue_rescue", "lead_import"],
      usageLimits: { seats: 5 },
      allowedOrigins: [],
      owner: { email: `owner-${RUN}@rescue-test.local`, name: "Owner" },
    },
  });
  assert.equal(provision.status, 201, JSON.stringify(provision.json));
  state.org = provision.json.organizationId;

  const accept = await request("/api/invites/accept", {
    method: "POST",
    body: { token: provision.json.inviteToken, name: "Owner", password: "password-ri-123" },
  });
  assert.equal(accept.status, 200);
  state.owner = accept.cookie;

  // Second org + owner for cross-tenant checks.
  const provisionB = await request("/api/admin/organizations", {
    method: "POST",
    cookie: adminLogin.cookie,
    body: {
      name: `Test ${RUN} Outsider`,
      slug: `test-${RUN}-b`,
      plan: "starter",
      modules: ["revenue_rescue", "lead_import"],
      // High import capacity: this org bulk-imports 12k rows to test pipeline
      // concurrency, which must not trip the (separately tested) usage limits.
      usageLimits: { seats: 2, leads_imported: 100000, leads_stored: 100000 },
      allowedOrigins: [],
      owner: { email: `outsider-${RUN}@rescue-test.local`, name: "Outsider" },
    },
  });
  assert.equal(provisionB.status, 201);
  state.orgB = provisionB.json.organizationId;
  const acceptB = await request("/api/invites/accept", {
    method: "POST",
    body: { token: provisionB.json.inviteToken, name: "Outsider", password: "password-ri-456" },
  });
  assert.equal(acceptB.status, 200);
  state.outsider = acceptB.cookie;

  // Pre-seed a do-not-contact record that one imported row must honor.
  await db.query(
    "INSERT INTO suppression_records (organization_id, channel, value, reason, source) VALUES ($1, 'email', $2, 'Manual DNC', 'test-seed')",
    [state.org, `suppressed-${RUN}@rescue-test.local`],
  );
});

after(async () => {
  await cleanup();
  await db.end();
});

test("upload parses the file and proposes an auto-mapping", async () => {
  const res = await request(`/api/orgs/${state.org}/imports`, { method: "POST", cookie: state.owner, form: csvFile("dormant-leads.csv", LEADS_CSV) });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const record = res.json.import;
  state.importId = record.id;
  assert.equal(record.status, "mapping_required");
  assert.equal(record.rowCount, 8);
  assert.equal(record.columns.length, 8);
  const targets = Object.fromEntries(record.autoMapping.map((m) => [m.sourceColumn, m.target]));
  assert.equal(targets["Email"], "email");
  assert.equal(targets["Phone"], "phone");
  assert.equal(targets["Estimate Amount"], "estimatedValue");
  assert.equal(targets["Lead ID"], "externalRecordId");
  assert.equal(targets["Consent"], "consentStatus");
  const emailColumn = record.autoMapping.find((m) => m.sourceColumn === "Email");
  assert.ok(emailColumn.confidence >= 0.9);
  assert.ok(emailColumn.sample.includes("@rescue-test.local"));
});

test("mapping without a contact field is rejected", async () => {
  const res = await request(`/api/orgs/${state.org}/imports/${state.importId}/mapping`, {
    method: "POST",
    cookie: state.owner,
    body: { mapping: { "First Name": "firstName", Notes: "notes" } },
  });
  assert.equal(res.status, 400);
});

test("pipeline runs: cleaning, dedupe, suppression, import with correct counts", async () => {
  const targets = {
    "First Name": "firstName", "Last Name": "lastName", Email: "email", Phone: "phone",
    "Estimate Amount": "estimatedValue", "Lead ID": "externalRecordId", Consent: "consentStatus", Notes: "notes",
  };
  const res = await request(`/api/orgs/${state.org}/imports/${state.importId}/mapping`, {
    method: "POST",
    cookie: state.owner,
    body: { mapping: targets },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));

  const record = await pollImport(state.org, state.importId, state.owner);
  assert.equal(record.status, "partial", JSON.stringify(record.stageLog)); // one invalid row
  assert.equal(record.rowCount, 8);
  assert.equal(record.importedCount, 5);
  assert.equal(record.duplicateCount, 2); // in-file email dup + external-id dup
  assert.equal(record.invalidCount, 1); // the no-contact row
  assert.equal(record.suppressedCount, 2); // opt-out row + seeded DNC match
  const stages = record.stageLog.map((entry) => entry.stage);
  for (const stage of ["uploaded", "validating", "cleaning", "deduplicating", "suppression_checking", "importing", "partial"]) {
    assert.ok(stages.includes(stage), `stage log missing ${stage}: ${stages.join(",")}`);
  }
});

test("leads are stored org-scoped, normalized, and suppression is honored", async () => {
  const { rows: leads } = await db.query(
    "SELECT * FROM rescue_leads WHERE organization_id = $1 ORDER BY created_at ASC",
    [state.org],
  );
  assert.equal(leads.length, 5);
  assert.ok(leads.every((lead) => lead.import_id === state.importId));

  const maria = leads.find((lead) => lead.email === `maria-${RUN}@rescue-test.local`);
  assert.equal(maria.phone_normalized, "+15552017788");
  assert.equal(Number(maria.estimated_value), 18500);
  assert.equal(maria.external_record_id, "L-1");
  assert.equal(maria.consent_status, "express");
  assert.equal(maria.suppressed, false);

  const dana = leads.find((lead) => lead.email === `dana-${RUN}@rescue-test.local`);
  assert.equal(dana.consent_status, "opted_out");
  assert.equal(dana.suppressed, true);

  const seeded = leads.find((lead) => lead.email === `suppressed-${RUN}@rescue-test.local`);
  assert.equal(seeded.suppressed, true);

  // The file's opt-out was added to the suppression list (email + phone).
  const { rows: suppressions } = await db.query(
    "SELECT channel, value FROM suppression_records WHERE organization_id = $1 ORDER BY created_at ASC",
    [state.org],
  );
  const values = suppressions.map((row) => row.value);
  assert.ok(values.includes(`dana-${RUN}@rescue-test.local`));
  assert.ok(values.includes("+15554430912"));
});

test("rejected-row export is formula-injection safe and explains reasons", async () => {
  const res = await request(`/api/orgs/${state.org}/imports/${state.importId}/rejected`, { cookie: state.owner });
  assert.equal(res.status, 200);
  assert.ok(res.text.startsWith("row_number,reason,"));
  assert.ok(res.text.includes("Duplicate in file"), "in-file duplicate reason present");
  assert.ok(res.text.includes("No contact info"), "invalid-row reason present");
  // The formula payload must be prefixed so spreadsheets treat it as text.
  assert.ok(res.text.includes(",'=CMD|' /C calc'!A0"), `formula not neutralized: ${res.text}`);
  assert.ok(!res.text.includes("\n=") && !res.text.includes(",=CMD"), "raw formula leaked into export");
});

test("re-importing the same file dedupes against existing leads", async () => {
  const upload = await request(`/api/orgs/${state.org}/imports`, { method: "POST", cookie: state.owner, form: csvFile("dormant-leads-again.csv", LEADS_CSV) });
  assert.equal(upload.status, 201);
  state.importId2 = upload.json.import.id;
  const mapping = Object.fromEntries(upload.json.import.autoMapping.map((m) => [m.sourceColumn, m.target]));
  const confirm = await request(`/api/orgs/${state.org}/imports/${state.importId2}/mapping`, {
    method: "POST",
    cookie: state.owner,
    body: { mapping },
  });
  assert.equal(confirm.status, 200);
  const record = await pollImport(state.org, state.importId2, state.owner);
  assert.equal(record.importedCount, 0, JSON.stringify(record));
  assert.equal(record.duplicateCount, 7); // 2 in-file + 5 against existing leads
  assert.equal(record.invalidCount, 1);
  const { rows } = await db.query("SELECT count(*)::int AS n FROM rescue_leads WHERE organization_id = $1", [state.org]);
  assert.equal(rows[0].n, 5, "no new leads inserted");
});

test("an all-duplicates file ends partial with zero imported, never complete", async () => {
  const csv = [
    "Email,First Name",
    `maria-${RUN}@rescue-test.local,Maria`,
    `james-${RUN}@rescue-test.local,James`,
  ].join("\n");
  const upload = await request(`/api/orgs/${state.org}/imports`, { method: "POST", cookie: state.owner, form: csvFile("all-dupes.csv", csv) });
  assert.equal(upload.status, 201);
  const confirm = await request(`/api/orgs/${state.org}/imports/${upload.json.import.id}/mapping`, {
    method: "POST",
    cookie: state.owner,
    body: { mapping: { Email: "email", "First Name": "firstName" } },
  });
  assert.equal(confirm.status, 200);
  const record = await pollImport(state.org, upload.json.import.id, state.owner);
  assert.equal(record.status, "partial", JSON.stringify(record));
  assert.equal(record.importedCount, 0);
  assert.equal(record.duplicateCount, 2);
  assert.ok(record.error?.includes("No new leads"), record.error);
});

test("retry is safe: reprocessing never double-inserts", async () => {
  const res = await request(`/api/orgs/${state.org}/imports/${state.importId2}/retry`, { method: "POST", cookie: state.owner });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const record = await pollImport(state.org, state.importId2, state.owner);
  assert.equal(record.importedCount, 0);
  assert.equal(record.duplicateCount, 7);
  const { rows } = await db.query("SELECT count(*)::int AS n FROM rescue_leads WHERE organization_id = $1", [state.org]);
  assert.equal(rows[0].n, 5, "lead count unchanged after retry");
});

test("retry during an active run is rejected and only one run proceeds", async () => {
  // Big file so the pipeline is reliably still running when we hit retry.
  const rows = ["Email,First Name"];
  for (let i = 0; i < 12000; i++) rows.push(`bulk${i}-${RUN}@rescue-test.local,Lead${i}`);
  const upload = await request(`/api/orgs/${state.orgB}/imports`, { method: "POST", cookie: state.outsider, form: csvFile("bulk.csv", rows.join("\n")) });
  assert.equal(upload.status, 201, JSON.stringify(upload.json));
  const importId = upload.json.import.id;

  const confirm = await request(`/api/orgs/${state.orgB}/imports/${importId}/mapping`, {
    method: "POST",
    cookie: state.outsider,
    body: { mapping: { Email: "email", "First Name": "firstName" } },
  });
  assert.equal(confirm.status, 200);

  // Immediately try to retry while the run holds the lease.
  const concurrentRetry = await request(`/api/orgs/${state.orgB}/imports/${importId}/retry`, { method: "POST", cookie: state.outsider });
  assert.equal(concurrentRetry.status, 409, JSON.stringify(concurrentRetry.json));

  // Re-confirming the mapping mid-run must not start a second run either.
  const concurrentMapping = await request(`/api/orgs/${state.orgB}/imports/${importId}/mapping`, {
    method: "POST",
    cookie: state.outsider,
    body: { mapping: { Email: "email", "First Name": "firstName" } },
  });
  assert.equal(concurrentMapping.status, 409);

  const record = await pollImport(state.orgB, importId, state.outsider, 120000);
  assert.equal(record.status, "complete", JSON.stringify(record));
  assert.equal(record.importedCount, 12000);
  const { rows: counted } = await db.query("SELECT count(*)::int AS n FROM rescue_leads WHERE organization_id = $1", [state.orgB]);
  assert.equal(counted[0].n, 12000, "exactly one pipeline run inserted leads");

  // Once complete, retry is refused outright.
  const afterComplete = await request(`/api/orgs/${state.orgB}/imports/${importId}/retry`, { method: "POST", cookie: state.outsider });
  assert.equal(afterComplete.status, 409);
});

test("cross-tenant access to imports is denied", async () => {
  const list = await request(`/api/orgs/${state.org}/imports`, { cookie: state.outsider });
  assert.equal(list.status, 403);
  const detail = await request(`/api/orgs/${state.org}/imports/${state.importId}`, { cookie: state.outsider });
  assert.equal(detail.status, 403);
  const rejected = await request(`/api/orgs/${state.org}/imports/${state.importId}/rejected`, { cookie: state.outsider });
  assert.equal(rejected.status, 403);
  const anonymous = await request(`/api/orgs/${state.org}/imports`);
  assert.equal(anonymous.status, 401);
});

test("intake file import is blocked when the org lacks the lead_import module", async () => {
  const adminLogin = await request("/api/admin/session", { method: "POST", body: { password: process.env.ADMIN_PASSWORD } });
  const provision = await request("/api/admin/organizations", {
    method: "POST",
    cookie: adminLogin.cookie,
    body: {
      name: `Test ${RUN} NoImport`,
      slug: `test-${RUN}-c`,
      plan: "starter",
      modules: ["revenue_rescue"], // no lead_import
      usageLimits: { seats: 2 },
      allowedOrigins: [],
      owner: { email: `noent-${RUN}@rescue-test.local`, name: "No Entitlement" },
    },
  });
  assert.equal(provision.status, 201);
  const accept = await request("/api/invites/accept", {
    method: "POST",
    body: { token: provision.json.inviteToken, name: "No Entitlement", password: "password-ri-000" },
  });
  assert.equal(accept.status, 200);

  const intake = {
    company: { name: `Test ${RUN} NoImport`, website: "", industry: "Roofing", serviceArea: "Toledo, OH", averageJobValue: 9000 },
    leadSources: { sources: ["crm_export"], estimatedDormantLeads: 50, notes: "" },
    campaignPreferences: { channels: ["email"], tone: "professional", approveBeforeSending: true },
    confirmations: { ownsData: true, hasContactPermission: true, honorsOptOuts: true },
  };
  const form = new FormData();
  form.append("intake", JSON.stringify(intake));
  form.append("file", new File(["Email\nblocked-" + RUN + "@rescue-test.local"], "blocked.csv", { type: "text/csv" }));
  const denied = await request("/api/revenue-rescue/intake", { method: "POST", cookie: accept.cookie, form });
  assert.equal(denied.status, 403, JSON.stringify(denied.json));

  // Every import route — reads included — is gated on the module.
  const orgId = provision.json.organizationId;
  const direct = await request(`/api/orgs/${orgId}/imports`, {
    method: "POST",
    cookie: accept.cookie,
    form: csvFile("blocked2.csv", "Email\nblocked2-" + RUN + "@rescue-test.local"),
  });
  assert.equal(direct.status, 403);
  const list = await request(`/api/orgs/${orgId}/imports`, { cookie: accept.cookie });
  assert.equal(list.status, 403);
  const fakeImportId = crypto.randomUUID();
  const detail = await request(`/api/orgs/${orgId}/imports/${fakeImportId}`, { cookie: accept.cookie });
  assert.equal(detail.status, 403);
  const rejectedExport = await request(`/api/orgs/${orgId}/imports/${fakeImportId}/rejected`, { cookie: accept.cookie });
  assert.equal(rejectedExport.status, 403);
  const retryBlocked = await request(`/api/orgs/${orgId}/imports/${fakeImportId}/retry`, { method: "POST", cookie: accept.cookie });
  assert.equal(retryBlocked.status, 403);
  const mappingBlocked = await request(`/api/orgs/${orgId}/imports/${fakeImportId}/mapping`, {
    method: "POST",
    cookie: accept.cookie,
    body: { mapping: { Email: "email" } },
  });
  assert.equal(mappingBlocked.status, 403);

  // Intake without a file (no import) is still allowed.
  const noFileForm = new FormData();
  noFileForm.append("intake", JSON.stringify(intake));
  const ok = await request("/api/revenue-rescue/intake", { method: "POST", cookie: accept.cookie, form: noFileForm });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.importId, null);
});

test("intake wizard submission creates an org and runs the first import", async () => {
  const register = await request("/api/auth/register", {
    method: "POST",
    body: { email: `intake-${RUN}@rescue-test.local`, name: "Intake User", password: "password-ri-789" },
  });
  assert.equal(register.status, 201);
  const cookie = register.cookie;

  const intake = {
    company: { name: `Rescue Intake Co ${RUN}`, website: "example.com", industry: "Roofing", serviceArea: "Columbus, OH", averageJobValue: 12000 },
    leadSources: { sources: ["crm_export", "missed_calls"], estimatedDormantLeads: 100, notes: "" },
    campaignPreferences: { channels: ["sms", "email"], tone: "professional", approveBeforeSending: true },
    confirmations: { ownsData: true, hasContactPermission: true, honorsOptOuts: true },
  };
  const csv = ["Email,First Name,Phone", `lead1-${RUN}@rescue-test.local,Lee,555-101-2020`, `lead2-${RUN}@rescue-test.local,Kim,555-303-4040`].join("\n");
  const form = new FormData();
  form.append("intake", JSON.stringify(intake));
  form.append("file", new File([csv], "starter.csv", { type: "text/csv" }));
  form.append("mapping", JSON.stringify({ Email: "email", "First Name": "firstName", Phone: "phone" }));

  const res = await request("/api/revenue-rescue/intake", { method: "POST", cookie, form });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.organizationCreated, true);
  assert.ok(res.json.importId);

  const record = await pollImport(res.json.organizationId, res.json.importId, cookie);
  assert.equal(record.status, "complete", JSON.stringify(record));
  assert.equal(record.importedCount, 2);

  const { rows } = await db.query("SELECT count(*)::int AS n FROM rescue_leads WHERE organization_id = $1", [res.json.organizationId]);
  assert.equal(rows[0].n, 2);

  // Confirmations must be enforced server-side.
  const badIntake = { ...intake, confirmations: { ownsData: true, hasContactPermission: false, honorsOptOuts: true } };
  const badForm = new FormData();
  badForm.append("intake", JSON.stringify(badIntake));
  const bad = await request("/api/revenue-rescue/intake", { method: "POST", cookie, form: badForm });
  assert.equal(bad.status, 400);
});
