/**
 * Unit tests for generateFollowUpDraft's AI branch with a scripted OpenAI
 * client (no network, no real key). Proves the compliance guarantee: every
 * path ends in either an opt-out-bearing AI draft or the deterministic
 * per-attempt template fallback, and suppressed/opted-out leads throw before
 * the model is ever invoked.
 *
 * Run alone: node --test tests/rescue-followup-draft-ai.test.mjs
 */
import { register } from "node:module";
register("./helpers/server-lib-loader.mjs", import.meta.url);
register("./helpers/openai-stub-loader.mjs", import.meta.url);

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// The AI branch only runs when a key exists; the stub never reads it.
process.env.OPENAI_API_KEY = "sk-test-fake";

const { scriptResponse, scriptError, resetStub, calls } = await import("./helpers/openai-stub.mjs");
const { generateFollowUpDraft, generateMessageDraft, SuppressedLeadError } = await import("../lib/rescue-analysis/messages.ts");
const { SMS_OPT_OUT, EMAIL_OPT_OUT } = await import("../lib/rescue-analysis/message-content.ts");

function makeLead(overrides = {}) {
  return {
    firstName: "Maria",
    lastName: "Lopez",
    email: "maria@example.com",
    emailNormalized: "maria@example.com",
    phone: "(555) 201-7788",
    phoneNormalized: "+15552017788",
    address: null,
    city: "Dallas",
    state: "TX",
    zip: "75201",
    projectType: "Roof replacement",
    projectDescription: null,
    estimatedValue: 18500,
    source: "Website form",
    sourceDetail: null,
    firstContactDate: "2026-06-15",
    lastContactDate: "2026-07-10",
    estimateDate: "2026-07-01",
    consentStatus: "express",
    suppressed: false,
    suppressionReason: null,
    status: "imported",
    notes: null,
    id: "lead-test-1",
    ...overrides,
  };
}

const followUpOptions = (overrides = {}) => ({
  channel: "sms",
  tone: "professional",
  attemptNumber: 2,
  maxAttempts: 3,
  ...overrides,
});

beforeEach(() => resetStub());

// ---------- Opt-out is enforced on AI output ----------

test("SMS opt-out is appended when the model omits it", async () => {
  scriptResponse(JSON.stringify({ body: "Hi Maria, just checking in on your roof replacement project." }));
  const draft = await generateFollowUpDraft(makeLead(), followUpOptions(), "Acme Roofing");
  assert.equal(draft.mode, "ai");
  assert.ok(String(draft.content.body).endsWith(SMS_OPT_OUT), "opt-out must be appended to non-compliant AI SMS");
});

test("email opt-out is appended when the model omits it", async () => {
  scriptResponse(JSON.stringify({ subject: "Checking in", body: "Hi Maria,\n\nJust circling back on your project." }));
  const draft = await generateFollowUpDraft(makeLead(), followUpOptions({ channel: "email" }), "Acme Roofing");
  assert.equal(draft.mode, "ai");
  assert.ok(String(draft.content.body).includes(EMAIL_OPT_OUT), "opt-out must be appended to non-compliant AI email");
});

test("compliant AI output is left untouched", async () => {
  const body = `Hi Maria, circling back on your roof project. ${SMS_OPT_OUT}`;
  scriptResponse(JSON.stringify({ body }));
  const draft = await generateFollowUpDraft(makeLead(), followUpOptions(), "Acme Roofing");
  assert.equal(draft.mode, "ai");
  assert.equal(draft.content.body, body);
});

test("code-fenced JSON is tolerated and still gets opt-out enforced", async () => {
  scriptResponse("```json\n" + JSON.stringify({ body: "Hi Maria, quick check-in on the roof." }) + "\n```");
  const draft = await generateFollowUpDraft(makeLead(), followUpOptions(), "Acme Roofing");
  assert.equal(draft.mode, "ai");
  assert.ok(String(draft.content.body).endsWith(SMS_OPT_OUT));
});

// ---------- Bad model output falls back to the per-attempt template ----------

test("malformed JSON falls back to the per-attempt template variant (attempt 2 = check-in)", async () => {
  scriptResponse("Sorry, I can't produce JSON right now.");
  const draft = await generateFollowUpDraft(makeLead(), followUpOptions({ attemptNumber: 2, maxAttempts: 3 }), "Acme Roofing");
  assert.equal(draft.mode, "template");
  assert.match(String(draft.content.body), /checking in/i);
  assert.ok(String(draft.content.body).includes(SMS_OPT_OUT));
});

test("schema-violating draft (empty body) falls back to the final-attempt closing template", async () => {
  scriptResponse(JSON.stringify({ body: "" }));
  const draft = await generateFollowUpDraft(makeLead(), followUpOptions({ attemptNumber: 3, maxAttempts: 3 }), "Acme Roofing");
  assert.equal(draft.mode, "template");
  assert.match(String(draft.content.body), /close your file/i);
  assert.ok(String(draft.content.body).includes(SMS_OPT_OUT));
});

test("wrong-shape email output falls back to a compliant email template", async () => {
  scriptResponse(JSON.stringify({ body: "missing the subject field" }));
  const draft = await generateFollowUpDraft(makeLead(), followUpOptions({ channel: "email", attemptNumber: 2, maxAttempts: 3 }), "Acme Roofing");
  assert.equal(draft.mode, "template");
  assert.ok(String(draft.content.body).includes(EMAIL_OPT_OUT));
  assert.ok(String(draft.content.subject).length > 0);
});

test("model/API errors fall back to a compliant template draft", async () => {
  scriptError("simulated OpenAI outage");
  const draft = await generateFollowUpDraft(makeLead(), followUpOptions(), "Acme Roofing");
  assert.equal(draft.mode, "template");
  assert.ok(String(draft.content.body).includes(SMS_OPT_OUT));
});

// ---------- Suppression precedes generation ----------

test("suppressed leads throw before the model is ever called", async () => {
  scriptResponse(JSON.stringify({ body: "should never be used" }));
  await assert.rejects(
    () => generateFollowUpDraft(makeLead({ suppressed: true }), followUpOptions(), "Acme Roofing"),
    SuppressedLeadError,
  );
  assert.equal(calls.length, 0, "no OpenAI call may happen for a suppressed lead");
});

test("opted-out leads throw before the model is ever called", async () => {
  scriptResponse(JSON.stringify({ body: "should never be used" }));
  await assert.rejects(
    () => generateFollowUpDraft(makeLead({ consentStatus: "opted_out" }), followUpOptions(), "Acme Roofing"),
    SuppressedLeadError,
  );
  assert.equal(calls.length, 0);
});

test("generateMessageDraft (one-off drafts) also blocks suppressed leads pre-generation", async () => {
  scriptResponse(JSON.stringify({ body: "should never be used" }));
  await assert.rejects(
    () => generateMessageDraft(makeLead({ suppressed: true }), { type: "sms", tone: "professional", includeOptOutLanguage: true }, "Acme Roofing"),
    SuppressedLeadError,
  );
  assert.equal(calls.length, 0);
});

// ---------- Attempt context reaches the prompt ----------

test("the prompt carries attempt number, final-attempt framing, and the booking link", async () => {
  scriptResponse(JSON.stringify({ body: `Last note about your roof. ${SMS_OPT_OUT}` }));
  await generateFollowUpDraft(
    makeLead(),
    followUpOptions({ attemptNumber: 3, maxAttempts: 3, bookingLink: "https://example.com/book/tok123" }),
    "Acme Roofing",
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].input, /attempt 3 of at most 3/);
  assert.match(calls[0].input, /FINAL planned touch/);
  assert.ok(calls[0].input.includes("https://example.com/book/tok123"));
  assert.match(calls[0].instructions, /Opt-out language is REQUIRED/);
});
