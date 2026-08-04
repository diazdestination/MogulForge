/**
 * Unit tests for the Revenue Rescue engagement pure modules:
 * reply classification (the safety-critical categories must win over
 * everything else), routing rules, campaign eligibility invariants,
 * and provider honesty (no provider ever reports as connected without
 * credentials).
 *
 *   npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyReply, REPLY_ROUTING, REPLY_CATEGORIES } from "../lib/rescue-engage/replies.ts";
import { getProviderStatus, liveSendingAvailable } from "../lib/rescue-engage/providers.ts";
import { resolveCalendarAdapters } from "../lib/rescue-engage/calendar-adapters.ts";
import { parseCampaignInput, CampaignValidationError } from "../lib/rescue-engage/campaign-schema.ts";
import { MANUAL_STAGES, PIPELINE_STAGES } from "../lib/rescue-engage/pipeline.ts";

// ---------- Reply classification ----------

test("opt-out phrasing always classifies as opt_out", () => {
  for (const text of ["STOP", "stop", "Please UNSUBSCRIBE me", "remove me from your list", "don't contact me again", "opt out"]) {
    const result = classifyReply(text);
    assert.equal(result.category, "opt_out", `"${text}" should be opt_out, got ${result.category}`);
  }
});

test("opt-out beats interested language in the same message", () => {
  // Safety rule: any opt-out phrasing wins over everything else in the message.
  const result = classifyReply("I was interested but please stop texting me");
  assert.equal(result.category, "opt_out");
});

test("complaints and legal threats classify as complaint and beat other signals", () => {
  const result = classifyReply("This is harassment, I will report you to my lawyer");
  assert.equal(result.category, "complaint");
});

test("sensitive circumstances are detected", () => {
  const result = classifyReply("My husband passed away last month, the project is off");
  assert.equal(result.category, "sensitive");
});

test("interested and appointment replies classify positively", () => {
  assert.equal(classifyReply("Yes, I'm still interested!").category, "interested");
  assert.equal(classifyReply("Can we schedule a time for you to come out?").category, "wants_appointment");
});

test("unrecognized text falls back to unknown with low confidence", () => {
  const result = classifyReply("qwerty asdf zxcv");
  assert.equal(result.category, "unknown");
  assert.ok(result.confidence <= 0.5);
});

// ---------- Routing rules ----------

test("every reply category has a routing rule", () => {
  for (const category of REPLY_CATEGORIES) {
    assert.ok(REPLY_ROUTING[category], `missing routing for ${category}`);
  }
});

test("opt_out routing suppresses immediately and unconditionally", () => {
  const routing = REPLY_ROUTING.opt_out;
  assert.equal(routing.suppress, true);
  assert.equal(routing.stopAutomation, "all");
});

test("complaint and sensitive stop ALL automation and escalate to a human", () => {
  for (const category of ["complaint", "sensitive"]) {
    const routing = REPLY_ROUTING[category];
    assert.equal(routing.stopAutomation, "all", `${category} must stop all automation`);
    assert.equal(routing.escalate, true, `${category} must escalate`);
    assert.ok(routing.task, `${category} must create a follow-up task`);
    assert.equal(routing.task.source, "escalation");
  }
});

test("interested replies notify the assignee", () => {
  const routing = REPLY_ROUTING.interested;
  assert.equal(routing.notifyAssignee, true);
  assert.ok(routing.task);
});

// ---------- Campaign schema ----------

test("opt_out stop condition is always forced on", () => {
  const input = parseCampaignInput({ name: "Test", channel: "sms", stopConditions: ["reply"] });
  assert.ok(input.stopConditions.includes("opt_out"), "opt_out must be forced into stop conditions");
});

test("invalid campaign channel is rejected", () => {
  assert.throws(() => parseCampaignInput({ name: "Test", channel: "carrier_pigeon" }), CampaignValidationError);
});

// ---------- Provider honesty ----------

test("no provider reports connected without credentials; live sending unavailable", () => {
  for (const channel of ["sms", "email"]) {
    const status = getProviderStatus(channel);
    assert.equal(status.connected, false, `${channel} provider must be honest about not being connected`);
    assert.equal(liveSendingAvailable(channel), false);
  }
});

test("calendar adapters: with nothing connected, only manual is available", () => {
  const adapters = resolveCalendarAdapters({ google: false, outlook: false, calendly: false, syncProvider: "none", calendlyUrl: "", bookingUrl: "" });
  const manual = adapters.find((a) => a.id === "manual");
  assert.ok(manual?.connected, "manual scheduling must be available");
  for (const adapter of adapters.filter((a) => a.id !== "manual")) {
    assert.equal(adapter.connected, false, `${adapter.id} must report not connected`);
  }
});

// ---------- Pipeline ----------

test("manual stages exclude system-controlled ones", () => {
  for (const stage of MANUAL_STAGES) assert.ok(PIPELINE_STAGES.includes(stage));
  assert.ok(!MANUAL_STAGES.includes("suppressed"), "suppressed is never a manual stage");
});
