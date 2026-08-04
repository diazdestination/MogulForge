import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAnalysisHotLeadsEmail,
  buildAppointmentAlertEmail,
  buildHotLeadAlertEmail,
  buildOrgDigestEmail,
  buildReplyAlertEmail,
  digestHasActivity,
  escapeHtml,
} from "../lib/org-alerts-content.ts";

test("escapeHtml neutralizes markup", () => {
  assert.equal(escapeHtml(`<img src="x" & more>`), "&lt;img src=&quot;x&quot; &amp; more&gt;");
});

test("hot lead alert escapes lead-controlled reply text", () => {
  const email = buildHotLeadAlertEmail({
    orgName: "Acme Roofing",
    leadName: "Paula <script>alert(1)</script>",
    replyBody: `yes! <b>call me</b>`,
    channel: "sms",
    categoryLabel: "Interested",
  });
  assert.match(email.subject, /Hot lead/);
  assert.ok(!email.html.includes("<script>"));
  assert.ok(email.html.includes("&lt;b&gt;call me&lt;/b&gt;"));
  assert.ok(email.html.includes("SMS"));
});

test("analysis hot-leads summary email pluralizes and escapes org name", () => {
  const many = buildAnalysisHotLeadsEmail({ orgName: "Acme <Roofing>", hotCount: 12, analyzedCount: 200 });
  assert.equal(many.subject, "Analysis found 12 hot opportunities");
  assert.ok(many.html.includes("12 of 200 analyzed leads"));
  assert.ok(!many.html.includes("<Roofing>"));

  const one = buildAnalysisHotLeadsEmail({ orgName: "Acme", hotCount: 1, analyzedCount: 1 });
  assert.equal(one.subject, "Analysis found 1 hot opportunity");
  assert.ok(one.html.includes("1 of 1 analyzed lead as hot opportunity"));
});

test("reply alert includes category and channel", () => {
  const email = buildReplyAlertEmail({
    orgName: "Acme",
    leadName: "Sam Doe",
    replyBody: "who is this?",
    channel: "email",
    categoryLabel: "Wrong person",
  });
  assert.equal(email.subject, "New reply from Sam Doe (Wrong person)");
  assert.ok(email.html.includes("Wrong person"));
});

test("appointment alert formats valid dates and passes through invalid ones", () => {
  const email = buildAppointmentAlertEmail({
    orgName: "Acme",
    leadName: "Sam Doe",
    appointmentType: "estimate",
    scheduledStart: "2026-08-10T15:00:00.000Z",
    timezone: "America/Phoenix",
    address: "123 Main St",
    source: "Dashboard",
  });
  assert.ok(email.html.includes("Mon, 10 Aug 2026"));
  assert.ok(email.html.includes("America/Phoenix"));
  assert.ok(email.html.includes("123 Main St"));
});

test("digest activity gate and stat rendering", () => {
  const empty = { newLeads: 0, repliesReceived: 0, appointmentsBooked: 0, hotLeads: 0, outboundMessages: 0 };
  assert.equal(digestHasActivity(empty), false);
  const stats = { ...empty, repliesReceived: 3 };
  assert.equal(digestHasActivity(stats), true);
  const email = buildOrgDigestEmail({ orgName: "Acme", since: new Date("2026-07-27T00:00:00Z"), stats });
  assert.equal(email.subject, "Acme — weekly activity digest");
  assert.ok(email.html.includes("Replies"));
  assert.ok(email.html.includes(">3<"));
});
