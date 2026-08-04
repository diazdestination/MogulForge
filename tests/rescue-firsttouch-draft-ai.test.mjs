/**
 * Unit tests for generateFirstTouchDraft's AI branch with a scripted OpenAI
 * client (no network, no real key). Proves the compliance guarantee: every
 * path ends in either an opt-out-bearing AI draft or the deterministic
 * template fallback, and suppressed/opted-out leads throw before the model is
 * ever invoked.
 *
 * Run alone: node --test tests/rescue-firsttouch-draft-ai.test.mjs
 */
import { register } from "node:module";
register("./helpers/server-lib-loader.mjs", import.meta.url);
register("./helpers/openai-stub-loader.mjs", import.meta.url);

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// The AI branch only runs when a key exists; the stub never reads it.
process.env.OPENAI_API_KEY = "sk-test-fake";

const { scriptResponse, scriptError, resetStub, calls } = await import("./helpers/openai-stub.mjs");
const { generateFirstTouchDraft, SuppressedLeadError } = await import("../lib/rescue-analysis/messages.ts");
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

const firstTouchOptions = (overrides = {}) => ({
  channel: "sms",
  tone: "professional",
  ...overrides,
});

beforeEach(() => resetStub());

// ---------- Opt-out is enforced on AI SMS output ----------

test("SMS opt-out is appended when the model omits it", async () => {
  scriptResponse(JSON.stringify({ body: "Hi Maria, we're Acme Roofing. Quick question about your roof replacement project — still on the radar?" }));
  const draft = await generateFirstTouchDraft(makeLead(), firstTouchOptions(), "Acme Roofing");
  assert.equal(draft.mode, "ai");
  assert.ok(String(draft.content.body).endsWith(SMS_OPT_OUT), "opt-out must be appended to non-compliant AI SMS");
});

test("email opt-out is appended when the model omits it", async () => {
  scriptResponse(JSON.stringify({ subject: "Your roof project", body: "Hi Maria,\n\nWe wanted to reach out about your roof replacement inquiry." }));
  const draft = await generateFirstTouchDraft(makeLead(), firstTouchOptions({ channel: "email" }), "Acme Roofing");
  assert.equal(draft.mode, "ai");
  assert.ok(String(draft.content.body).includes(EMAIL_OPT_OUT), "opt-out must be appended to non-compliant AI email");
});

// ---------- Compliant AI output is left untouched ----------

test("compliant SMS output (already has opt-out) is returned as-is", async () => {
  const body = `Hi Maria, Acme Roofing here. Quick check on your roof replacement. ${SMS_OPT_OUT}`;
  scriptResponse(JSON.stringify({ body }));
  const draft = await generateFirstTouchDraft(makeLead(), firstTouchOptions(), "Acme Roofing");
  assert.equal(draft.mode, "ai");
  assert.equal(draft.content.body, body);
});

test("code-fenced JSON is tolerated and opt-out is still enforced", async () => {
  scriptResponse("```json\n" + JSON.stringify({ body: "Hi Maria, reaching out about your roof project." }) + "\n```");
  const draft = await generateFirstTouchDraft(makeLead(), firstTouchOptions(), "Acme Roofing");
  assert.equal(draft.mode, "ai");
  assert.ok(String(draft.content.body).endsWith(SMS_OPT_OUT));
});

// ---------- Bad model output falls back to the template ----------

test("malformed JSON falls back to the template draft with opt-out language", async () => {
  scriptResponse("Sorry, I cannot generate that right now.");
  const draft = await generateFirstTouchDraft(makeLead(), firstTouchOptions(), "Acme Roofing");
  assert.equal(draft.mode, "template");
  assert.ok(String(draft.content.body).includes(SMS_OPT_OUT));
});

test("schema-violating SMS draft (empty body) falls back to the template with opt-out", async () => {
  scriptResponse(JSON.stringify({ body: "" }));
  const draft = await generateFirstTouchDraft(makeLead(), firstTouchOptions(), "Acme Roofing");
  assert.equal(draft.mode, "template");
  assert.ok(String(draft.content.body).includes(SMS_OPT_OUT));
});

test("wrong-shape email output (missing subject) falls back to a compliant email template", async () => {
  scriptResponse(JSON.stringify({ body: "Missing the subject field entirely." }));
  const draft = await generateFirstTouchDraft(makeLead(), firstTouchOptions({ channel: "email" }), "Acme Roofing");
  assert.equal(draft.mode, "template");
  assert.ok(String(draft.content.body).includes(EMAIL_OPT_OUT));
  assert.ok(String(draft.content.subject).length > 0);
});

test("model/API errors fall back to a compliant template draft — activation never throws", async () => {
  scriptError("simulated OpenAI outage");
  const draft = await generateFirstTouchDraft(makeLead(), firstTouchOptions(), "Acme Roofing");
  assert.equal(draft.mode, "template");
  assert.ok(String(draft.content.body).includes(SMS_OPT_OUT));
});

// ---------- No-key path uses the template ----------

test("missing OPENAI_API_KEY falls back to the template without calling the model", async () => {
  const savedKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const draft = await generateFirstTouchDraft(makeLead(), firstTouchOptions(), "Acme Roofing");
    assert.equal(draft.mode, "template");
    assert.ok(String(draft.content.body).includes(SMS_OPT_OUT));
    assert.equal(calls.length, 0, "no OpenAI call must occur without a key");
  } finally {
    process.env.OPENAI_API_KEY = savedKey;
  }
});

test("email template fallback (no key) also carries opt-out language", async () => {
  const savedKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const draft = await generateFirstTouchDraft(makeLead(), firstTouchOptions({ channel: "email" }), "Acme Roofing");
    assert.equal(draft.mode, "template");
    assert.ok(String(draft.content.body).includes(EMAIL_OPT_OUT));
    assert.equal(calls.length, 0);
  } finally {
    process.env.OPENAI_API_KEY = savedKey;
  }
});

// ---------- Suppression precedes generation ----------

test("suppressed leads throw SuppressedLeadError before the model is ever called", async () => {
  scriptResponse(JSON.stringify({ body: "should never be used" }));
  await assert.rejects(
    () => generateFirstTouchDraft(makeLead({ suppressed: true }), firstTouchOptions(), "Acme Roofing"),
    SuppressedLeadError,
  );
  assert.equal(calls.length, 0, "no OpenAI call may happen for a suppressed lead");
});

test("opted-out leads throw SuppressedLeadError before the model is ever called", async () => {
  scriptResponse(JSON.stringify({ body: "should never be used" }));
  await assert.rejects(
    () => generateFirstTouchDraft(makeLead({ consentStatus: "opted_out" }), firstTouchOptions(), "Acme Roofing"),
    SuppressedLeadError,
  );
  assert.equal(calls.length, 0);
});

// ---------- First-touch framing reaches the prompt ----------

test("prompt uses first-touch framing (FIRST outreach, no 'checking back in' implication)", async () => {
  scriptResponse(JSON.stringify({ body: `Hi Maria, reaching out for the first time. ${SMS_OPT_OUT}` }));
  await generateFirstTouchDraft(makeLead(), firstTouchOptions(), "Acme Roofing");
  assert.equal(calls.length, 1);
  assert.match(calls[0].input, /FIRST outreach/i, "prompt must identify this as the first touch");
  assert.match(calls[0].instructions, /Opt-out language is REQUIRED/);
});

test("booking link is included verbatim in the prompt when provided", async () => {
  scriptResponse(JSON.stringify({ body: `Book here: https://example.com/book/tok456. ${SMS_OPT_OUT}` }));
  await generateFirstTouchDraft(
    makeLead(),
    firstTouchOptions({ bookingLink: "https://example.com/book/tok456" }),
    "Acme Roofing",
  );
  assert.equal(calls.length, 1);
  assert.ok(calls[0].input.includes("https://example.com/book/tok456"), "booking link must be injected into the prompt");
});
