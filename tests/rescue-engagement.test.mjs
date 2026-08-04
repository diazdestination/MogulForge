/**
 * HTTP tests for the Revenue Rescue engagement suite: campaign eligibility
 * (suppressed/opted-out contacts are never enrolled), simulation-mode
 * protection (live activation refused without a provider; simulated sends
 * never reported as delivered), reply routing (opt-out suppresses and stops
 * campaigns; complaints escalate), and role-based access (sales reps only see
 * assigned leads; analysts cannot write).
 *
 * Runs against the live dev server. Requires DATABASE_URL and ADMIN_PASSWORD.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const BASE = process.env.TEST_BASE_URL ?? "http://127.0.0.1:5000";
const RUN = `eng${Date.now().toString(36)}`;
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
    /* non-JSON */
  }
  return { status: response.status, json, cookie: sessionCookie };
}

async function cleanup() {
  await db.query("DELETE FROM organizations WHERE slug LIKE 'test-eng%'");
  await db.query("DELETE FROM users WHERE email LIKE '%@eng-test.local'");
}

async function seedLead(orgId, fields = {}) {
  const defaults = {
    first_name: "Lead",
    last_name: RUN,
    email: null,
    phone: null,
    consent_status: "express",
    suppressed: false,
    suppression_reason: null,
    score: 60,
    category: "worth_reengaging",
    analysis_status: "analyzed",
    pipeline_stage: "analyzed",
    assigned_user_id: null,
    estimated_value: 12000,
  };
  const row = { ...defaults, ...fields };
  row.email_normalized = row.email ? row.email.toLowerCase() : null;
  row.phone_normalized = row.phone ? row.phone.replace(/\D/g, "") : null;
  const cols = Object.keys(row);
  const { rows } = await db.query(
    `INSERT INTO rescue_leads (organization_id, ${cols.join(", ")})
     VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")}) RETURNING id`,
    [orgId, ...cols.map((c) => row[c])],
  );
  return rows[0].id;
}

const state = {};

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
      name: `Test ${RUN} Engage`,
      slug: `test-${RUN}`,
      plan: "scale",
      modules: ["revenue_rescue", "lead_import", "ai_analysis", "sms_campaigns", "email_campaigns", "appointments", "analytics"],
      usageLimits: { seats: 10 },
      allowedOrigins: [],
      owner: { email: `owner-${RUN}@eng-test.local`, name: "Owner" },
    },
  });
  assert.equal(provision.status, 201, JSON.stringify(provision.json));
  state.org = provision.json.organizationId;

  const acceptOwner = await request("/api/invites/accept", {
    method: "POST",
    body: { token: provision.json.inviteToken, name: "Owner", password: "password-own-123" },
  });
  assert.equal(acceptOwner.status, 200);
  state.ownerCookie = acceptOwner.cookie;

  // Invite a sales rep and a read-only analyst.
  for (const [key, role] of [["rep", "sales_rep"], ["analyst", "read_only_analyst"]]) {
    const invite = await request(`/api/orgs/${state.org}/members`, {
      method: "POST",
      cookie: state.ownerCookie,
      body: { email: `${key}-${RUN}@eng-test.local`, role },
    });
    assert.equal(invite.status, 201, JSON.stringify(invite.json));
    const accept = await request("/api/invites/accept", {
      method: "POST",
      body: { token: invite.json.invite.token, name: key, password: `password-${key}-123` },
    });
    assert.equal(accept.status, 200);
    state[`${key}Cookie`] = accept.cookie;
  }
  const repUser = await db.query("SELECT id FROM users WHERE email = $1", [`rep-${RUN}@eng-test.local`]);
  state.repUserId = repUser.rows[0].id;

  // Seed the lead population used across tests.
  state.leadGood = await seedLead(state.org, { first_name: "Alice", phone: "+15551230001", email: `alice-${RUN}@eng-test.local`, score: 85, category: "hot_opportunity" });
  state.leadSuppressed = await seedLead(state.org, { first_name: "Bob", phone: "+15551230002", suppressed: true, suppression_reason: "Asked to be removed" });
  state.leadOptedOut = await seedLead(state.org, { first_name: "Carol", phone: "+15551230003", consent_status: "opted_out" });
  state.leadDnc = await seedLead(state.org, { first_name: "Dan", phone: "+15551230004", category: "do_not_contact" });
  state.leadNoContact = await seedLead(state.org, { first_name: "Eve", phone: null, email: null });
  state.leadAssigned = await seedLead(state.org, { first_name: "Frank", phone: "+15551230006", assigned_user_id: state.repUserId });
  state.leadComplaint = await seedLead(state.org, { first_name: "Hank", phone: "+15551230008" });
});

after(async () => {
  await cleanup();
  await db.end();
});

// ---------- Campaign eligibility ----------

test("campaign preview accounts for every exclusion; suppressed/opted-out are never eligible", async () => {
  const create = await request(`/api/orgs/${state.org}/campaigns`, {
    method: "POST",
    cookie: state.ownerCookie,
    body: { name: `Eligibility ${RUN}`, channel: "sms", tone: "professional", stopConditions: ["reply"] },
  });
  assert.equal(create.status, 201, JSON.stringify(create.json));
  state.campaign = create.json.campaign.id;
  // opt_out stop condition must be forced on even though we omitted it
  assert.ok(create.json.campaign.stopConditions.includes("opt_out"));

  const preview = await request(`/api/orgs/${state.org}/campaigns/${state.campaign}/preview`, { cookie: state.ownerCookie });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  const acc = preview.json.accounting;
  assert.ok(acc.suppressed >= 1, "suppressed lead must be counted out");
  assert.ok(acc.optedOut >= 1, "opted-out lead must be counted out");
  assert.ok(acc.doNotContact >= 1, "do-not-contact lead must be counted out");
  assert.ok(acc.invalidContact >= 1, "lead without a phone must be counted out for sms");
  assert.equal(acc.eligible, 3, `Alice, Frank, Hank should be eligible: ${JSON.stringify(acc)}`);
});

// ---------- Simulation-mode protection ----------

test("activation without confirmation is refused", async () => {
  const res = await request(`/api/orgs/${state.org}/campaigns/${state.campaign}/activate`, {
    method: "POST",
    cookie: state.ownerCookie,
    body: { mode: "simulation" },
  });
  assert.equal(res.status, 400);
});

test("live activation is refused while no provider is connected — no silent downgrade", async () => {
  const res = await request(`/api/orgs/${state.org}/campaigns/${state.campaign}/activate`, {
    method: "POST",
    cookie: state.ownerCookie,
    body: { mode: "live", confirm: true },
  });
  assert.equal(res.status, 409, JSON.stringify(res.json));
  const campaign = await db.query("SELECT status FROM rescue_campaigns WHERE id = $1", [state.campaign]);
  assert.equal(campaign.rows[0].status, "draft", "failed live activation must not activate the campaign");
});

test("simulation activation enrolls only eligible leads and records simulated sends", async () => {
  const res = await request(`/api/orgs/${state.org}/campaigns/${state.campaign}/activate`, {
    method: "POST",
    cookie: state.ownerCookie,
    body: { mode: "simulation", confirm: true },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.enrolled, 3);
  assert.equal(res.json.simulatedSends, 3);

  const enrolled = await db.query("SELECT lead_id FROM rescue_campaign_leads WHERE campaign_id = $1", [state.campaign]);
  const enrolledIds = enrolled.rows.map((r) => r.lead_id);
  assert.ok(!enrolledIds.includes(state.leadSuppressed), "suppressed lead must never be enrolled");
  assert.ok(!enrolledIds.includes(state.leadOptedOut), "opted-out lead must never be enrolled");
  assert.ok(!enrolledIds.includes(state.leadDnc), "do-not-contact lead must never be enrolled");

  const messages = await db.query("SELECT simulated, status FROM rescue_messages WHERE campaign_id = $1", [state.campaign]);
  assert.equal(messages.rows.length, 3);
  for (const row of messages.rows) {
    assert.equal(row.simulated, true);
    assert.equal(row.status, "simulated", "simulated sends must never carry a real delivery status");
  }
});

test("DB constraint refuses to mark a simulated message as delivered", async () => {
  await assert.rejects(
    db.query("UPDATE rescue_messages SET status = 'delivered' WHERE campaign_id = $1", [state.campaign]),
    /rescue_messages_simulation_honesty/,
  );
});

test("overview never reports simulated sends as delivered", async () => {
  const res = await request(`/api/orgs/${state.org}/overview`, { cookie: state.ownerCookie });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.ok(res.json.metrics.cards.simulatedSends >= 3);
  assert.equal(res.json.metrics.cards.delivered, 0);
  assert.equal(res.json.providers.sms.connected, false);
});

// ---------- Reply routing ----------

test("opt-out reply suppresses the lead immediately and stops its campaigns", async () => {
  const res = await request(`/api/orgs/${state.org}/leads/${state.leadGood}/replies`, {
    method: "POST",
    cookie: state.ownerCookie,
    body: { channel: "sms", body: "STOP texting me" },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.category, "opt_out");

  const lead = await db.query("SELECT suppressed, consent_status, pipeline_stage FROM rescue_leads WHERE id = $1", [state.leadGood]);
  assert.equal(lead.rows[0].suppressed, true, "opt-out must suppress unconditionally");
  assert.equal(lead.rows[0].consent_status, "opted_out");
  assert.equal(lead.rows[0].pipeline_stage, "suppressed");

  const enrollment = await db.query(
    "SELECT status FROM rescue_campaign_leads WHERE campaign_id = $1 AND lead_id = $2",
    [state.campaign, state.leadGood],
  );
  assert.equal(enrollment.rows[0].status, "stopped", "opt-out must stop campaign enrollment");
});

test("complaint reply stops automation and escalates to a human task", async () => {
  const res = await request(`/api/orgs/${state.org}/leads/${state.leadComplaint}/replies`, {
    method: "POST",
    cookie: state.ownerCookie,
    body: { channel: "sms", body: "This is harassment and I am calling my lawyer" },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.category, "complaint");

  const tasks = await db.query(
    "SELECT source, status FROM rescue_tasks WHERE organization_id = $1 AND lead_id = $2",
    [state.org, state.leadComplaint],
  );
  assert.ok(tasks.rows.some((t) => t.source === "escalation" && t.status === "open"), "complaint must create an escalation task");
  const enrollment = await db.query(
    "SELECT status FROM rescue_campaign_leads WHERE campaign_id = $1 AND lead_id = $2",
    [state.campaign, state.leadComplaint],
  );
  assert.equal(enrollment.rows[0].status, "stopped");
});

test("interested reply marks the lead replied and creates a follow-up task", async () => {
  const res = await request(`/api/orgs/${state.org}/leads/${state.leadAssigned}/replies`, {
    method: "POST",
    cookie: state.repCookie,
    body: { channel: "sms", body: "Yes I'm still interested, please call me" },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.category, "interested");
  const lead = await db.query("SELECT pipeline_stage FROM rescue_leads WHERE id = $1", [state.leadAssigned]);
  assert.equal(lead.rows[0].pipeline_stage, "qualified");
});

// ---------- Role-based access ----------

test("sales rep only sees assigned leads", async () => {
  const res = await request(`/api/orgs/${state.org}/leads?limit=50`, { cookie: state.repCookie });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.scopedToAssigned, true);
  const ids = res.json.leads.map((l) => l.id);
  assert.deepEqual(ids, [state.leadAssigned], "rep must only see their assigned lead");
});

test("sales rep cannot open an unassigned lead's detail", async () => {
  const res = await request(`/api/orgs/${state.org}/leads/${state.leadComplaint}`, { cookie: state.repCookie });
  assert.equal(res.status, 403);
});

test("read-only analyst can read but cannot write", async () => {
  const read = await request(`/api/orgs/${state.org}/overview`, { cookie: state.analystCookie });
  assert.equal(read.status, 200);

  const createCampaign = await request(`/api/orgs/${state.org}/campaigns`, {
    method: "POST",
    cookie: state.analystCookie,
    body: { name: "Nope", channel: "sms" },
  });
  assert.equal(createCampaign.status, 403, "analyst must not create campaigns");

  const patchLead = await request(`/api/orgs/${state.org}/leads/${state.leadAssigned}`, {
    method: "PATCH",
    cookie: state.analystCookie,
    body: { action: "note", note: "nope" },
  });
  assert.equal(patchLead.status, 403, "analyst must not modify leads");

  const book = await request(`/api/orgs/${state.org}/appointments`, {
    method: "POST",
    cookie: state.analystCookie,
    body: { leadId: state.leadAssigned, appointmentType: "estimate", scheduledStart: new Date(Date.now() + 86400000).toISOString() },
  });
  assert.equal(book.status, 403, "analyst must not book appointments");
});

test("sales rep cannot reassign leads (manager-only)", async () => {
  const res = await request(`/api/orgs/${state.org}/leads/${state.leadAssigned}`, {
    method: "PATCH",
    cookie: state.repCookie,
    body: { action: "assign", userId: null },
  });
  assert.equal(res.status, 403);
});

test("rep overview is scoped: campaign stats, activity, and task counts cover only assigned leads", async () => {
  const res = await request(`/api/orgs/${state.org}/overview`, { cookie: state.repCookie });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.scopedToAssigned, true);
  // Only Frank is assigned to the rep.
  assert.equal(res.json.metrics.cards.leadsImported, 1);
  for (const campaign of res.json.metrics.campaignPerformance) {
    assert.ok(campaign.enrolled <= 1, `rep campaign stats must only count their leads: ${JSON.stringify(campaign)}`);
    assert.ok(campaign.simulatedSends <= 1, "rep must not see org-wide send counts");
  }
  // Activity must reference the rep's leads only — never org-level entries
  // (null leadId, e.g. campaign activations) or other users' leads.
  assert.ok(res.json.metrics.recentActivity.length >= 1, "rep should see activity on their own lead");
  for (const activity of res.json.metrics.recentActivity) {
    assert.equal(activity.leadId, state.leadAssigned, `activity leaked to rep: ${JSON.stringify(activity)}`);
  }
});

test("rep cannot see or mutate follow-up tasks that are not theirs", async () => {
  // The complaint escalation task belongs to an unassigned lead.
  const escalation = await db.query(
    "SELECT id FROM rescue_tasks WHERE organization_id = $1 AND lead_id = $2 AND source = 'escalation' LIMIT 1",
    [state.org, state.leadComplaint],
  );
  assert.ok(escalation.rows.length === 1, "escalation task from the complaint test must exist");
  const taskId = escalation.rows[0].id;

  const inbox = await request(`/api/orgs/${state.org}/conversations`, { cookie: state.repCookie });
  assert.equal(inbox.status, 200);
  assert.ok(!inbox.json.tasks.some((t) => t.id === taskId), "rep task list must not include tasks on unassigned leads");
  for (const t of inbox.json.tasks) {
    assert.ok(
      t.assignedUserId === state.repUserId || t.leadId === state.leadAssigned,
      `task leaked to rep: ${JSON.stringify(t)}`,
    );
  }

  const patch = await request(`/api/orgs/${state.org}/tasks/${taskId}`, {
    method: "PATCH",
    cookie: state.repCookie,
    body: { status: "dismissed" },
  });
  assert.equal(patch.status, 403, "rep must not mutate a task that is not theirs");

  // A manager can still resolve it.
  const ownerPatch = await request(`/api/orgs/${state.org}/tasks/${taskId}`, {
    method: "PATCH",
    cookie: state.ownerCookie,
    body: { status: "done" },
  });
  assert.equal(ownerPatch.status, 200, JSON.stringify(ownerPatch.json));
});

test("rep campaign list and detail are scoped to assigned leads", async () => {
  // A second campaign with nobody enrolled must be invisible to the rep.
  const other = await request(`/api/orgs/${state.org}/campaigns`, {
    method: "POST",
    cookie: state.ownerCookie,
    body: { name: `Draft ${RUN}`, channel: "sms", tone: "friendly" },
  });
  assert.equal(other.status, 201);
  const draftId = other.json.campaign.id;

  const list = await request(`/api/orgs/${state.org}/campaigns`, { cookie: state.repCookie });
  assert.equal(list.status, 200, JSON.stringify(list.json));
  assert.equal(list.json.scopedToAssigned, true);
  const listedIds = list.json.campaigns.map((c) => c.id);
  assert.ok(listedIds.includes(state.campaign), "rep should see the campaign their lead is enrolled in");
  assert.ok(!listedIds.includes(draftId), "rep must not see campaigns without their leads");
  const scoped = list.json.campaigns.find((c) => c.id === state.campaign);
  assert.equal(scoped.stats.enrolled, 1, "rep campaign stats must count only their assigned leads");
  assert.ok(scoped.stats.simulatedSends <= 1, "rep must not see org-wide send counts");

  const detail = await request(`/api/orgs/${state.org}/campaigns/${state.campaign}`, { cookie: state.repCookie });
  assert.equal(detail.status, 200, JSON.stringify(detail.json));
  assert.equal(detail.json.stats.enrolled, 1);
  assert.deepEqual(
    detail.json.leads.map((l) => l.leadId),
    [state.leadAssigned],
    "rep must only see their own enrolled leads — never other users' lead data",
  );

  const hidden = await request(`/api/orgs/${state.org}/campaigns/${draftId}`, { cookie: state.repCookie });
  assert.equal(hidden.status, 404, "campaign without the rep's leads must be hidden from them");

  // Managers keep the full org view.
  const ownerDetail = await request(`/api/orgs/${state.org}/campaigns/${state.campaign}`, { cookie: state.ownerCookie });
  assert.equal(ownerDetail.status, 200);
  assert.equal(ownerDetail.json.stats.enrolled, 3);
});

// ---------- Appointments ----------

test("manual booking works and moves the lead to appointment_booked", async () => {
  const res = await request(`/api/orgs/${state.org}/appointments`, {
    method: "POST",
    cookie: state.repCookie,
    body: { leadId: state.leadAssigned, appointmentType: "estimate", scheduledStart: new Date(Date.now() + 86400000).toISOString(), address: "1 Main St" },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.appointment.provider, "manual");
  const lead = await db.query("SELECT pipeline_stage FROM rescue_leads WHERE id = $1", [state.leadAssigned]);
  assert.equal(lead.rows[0].pipeline_stage, "appointment_booked");

  const list = await request(`/api/orgs/${state.org}/appointments`, { cookie: state.ownerCookie });
  assert.equal(list.status, 200);
  assert.ok(list.json.appointments.some((a) => a.id === res.json.appointment.id));
  const manual = list.json.adapters.find((a) => a.id === "manual");
  assert.ok(manual.connected, "manual adapter must be available");
  // booking_url is connected whenever SESSION_SECRET can sign booking links;
  // every other non-manual adapter must be an honest not-connected stub.
  const bookingUrlAdapter = list.json.adapters.find((a) => a.id === "booking_url");
  assert.equal(bookingUrlAdapter.connected, true, "booking_url must be available when SESSION_SECRET is configured");
  for (const adapter of list.json.adapters.filter((a) => a.id !== "manual" && a.id !== "booking_url")) {
    assert.equal(adapter.connected, false, `${adapter.id} must be an honest not-connected stub`);
  }
});
