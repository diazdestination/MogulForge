/**
 * Unit tests for the lead analysis engine: deterministic signals, category
 * assignment, suppression precedence over AI output, AI schema validation,
 * and message-draft contracts. Pure-module tests — run directly against the
 * TypeScript sources (Node 22 strips types natively). No server or DB needed.
 *
 *   npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeDeterministic, detectLifecycleCategory } from "../lib/rescue-analysis/signals.ts";
import { mergeAnalysis } from "../lib/rescue-analysis/merge.ts";
import { parseAiAnalysis, extractJsonObject } from "../lib/rescue-analysis/ai-schema.ts";
import { LEAD_CATEGORIES, isLeadCategory } from "../lib/rescue-analysis/categories.ts";
import {
  buildLeadFactSheet,
  buildTemplateDraft,
  draftWarnings,
  parseMessageContent,
  messageRequestSchema,
  SMS_OPT_OUT,
} from "../lib/rescue-analysis/message-content.ts";

const NOW = new Date("2026-08-01T00:00:00Z");

/** A healthy, contactable lead. Override per test. */
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
    ...overrides,
  };
}

function makeAi(overrides = {}) {
  return {
    score: 85,
    category: "hot_opportunity",
    intent: "high",
    reasonStalled: "Estimate delivered but never followed up.",
    recommendedChannel: "sms",
    recommendedAction: "Send a short check-in text referencing the estimate.",
    recommendedAngle: "Pick up where the estimate left off.",
    summary: "Recent, high-value lead with an open estimate. Strong re-engagement candidate.",
    confidence: 0.9,
    riskFlags: [],
    ...overrides,
  };
}

// ---------- Deterministic signals ----------

test("a strong recent lead scores high with explainable signals", () => {
  const result = analyzeDeterministic(makeLead(), { now: NOW, serviceArea: "Dallas–Fort Worth, TX" });
  assert.ok(result.score >= 70, `expected >= 70, got ${result.score}`);
  assert.equal(result.category, "hot_opportunity");
  // Every point is accounted for by a named signal with a detail string.
  const keys = result.signals.map((s) => s.key);
  for (const key of ["base", "contact_channels", "recency", "value", "estimate", "consent", "service_area"]) {
    assert.ok(keys.includes(key), `missing signal ${key}`);
  }
  assert.ok(result.signals.every((s) => s.detail.length > 0));
  // The score equals base + sum of signal points (clamped): never a black box.
  const sum = result.signals.reduce((total, s) => total + s.points, 0);
  assert.equal(result.score, Math.max(0, Math.min(100, Math.round(sum))));
});

test("recency decays: old leads score lower than fresh ones", () => {
  const fresh = analyzeDeterministic(makeLead({ lastContactDate: "2026-07-25" }), { now: NOW });
  const yearOld = analyzeDeterministic(makeLead({ lastContactDate: "2025-05-01", estimateDate: null }), { now: NOW });
  const ancient = analyzeDeterministic(makeLead({ lastContactDate: "2023-01-01", estimateDate: null }), { now: NOW });
  assert.ok(fresh.score > yearOld.score);
  assert.ok(yearOld.score > ancient.score);
  assert.ok(ancient.signals.find((s) => s.key === "recency").points < 0);
});

test("value tiers award more points for bigger projects", () => {
  const scoreFor = (estimatedValue) =>
    analyzeDeterministic(makeLead({ estimatedValue }), { now: NOW }).signals.find((s) => s.key === "value").points;
  assert.equal(scoreFor(30000), 20);
  assert.equal(scoreFor(12000), 15);
  assert.equal(scoreFor(6000), 10);
  assert.equal(scoreFor(900), 5);
  assert.equal(scoreFor(null), 0);
});

test("unknown consent subtracts points and flags the lead", () => {
  const result = analyzeDeterministic(makeLead({ consentStatus: "unknown" }), { now: NOW });
  assert.ok(result.flags.includes("unknown_consent"));
  assert.equal(result.signals.find((s) => s.key === "consent").points, -5);
});

test("two or more unknowns route the lead to manual review", () => {
  const result = analyzeDeterministic(
    makeLead({ consentStatus: "unknown", firstContactDate: null, lastContactDate: null, estimateDate: null }),
    { now: NOW },
  );
  assert.equal(result.needsReview, true);
  assert.equal(result.category, "needs_manual_review");
});

test("service area mismatch penalizes and flags; match rewards", () => {
  const inArea = analyzeDeterministic(makeLead(), { now: NOW, serviceArea: "Dallas metro, TX" });
  assert.equal(inArea.signals.find((s) => s.key === "service_area").points, 6);
  const outArea = analyzeDeterministic(makeLead({ city: "Phoenix", state: "AZ", zip: "85001" }), { now: NOW, serviceArea: "Dallas metro, TX" });
  assert.equal(outArea.signals.find((s) => s.key === "service_area").points, -8);
  assert.ok(outArea.flags.includes("outside_service_area"));
});

// ---------- Hard gates ----------

test("suppressed leads are do_not_contact with score 0, no matter how good the facts", () => {
  const result = analyzeDeterministic(makeLead({ suppressed: true, suppressionReason: "Matches your do-not-contact list" }), { now: NOW });
  assert.equal(result.score, 0);
  assert.equal(result.category, "do_not_contact");
  assert.ok(result.flags.includes("suppressed"));
});

test("opted-out consent is a hard gate even when not marked suppressed", () => {
  const result = analyzeDeterministic(makeLead({ consentStatus: "opted_out", suppressed: false }), { now: NOW });
  assert.equal(result.category, "do_not_contact");
  assert.equal(result.score, 0);
});

test("leads without any valid contact channel are invalid_duplicate", () => {
  const result = analyzeDeterministic(makeLead({ emailNormalized: null, phoneNormalized: null }), { now: NOW });
  assert.equal(result.category, "invalid_duplicate");
  assert.equal(result.score, 0);
});

// ---------- Lifecycle keyword detection ----------

test("CRM status/notes keywords map to lifecycle categories", () => {
  assert.equal(detectLifecycleCategory({ status: "Closed-Lost", notes: null }).category, "previously_lost");
  assert.equal(detectLifecycleCategory({ status: null, notes: "went with another contractor" }).category, "previously_lost");
  assert.equal(detectLifecycleCategory({ status: "closed won", notes: null }).category, "existing_customer");
  assert.equal(detectLifecycleCategory({ status: null, notes: "sold the house last spring" }).category, "no_longer_qualified");
  assert.equal(detectLifecycleCategory({ status: "imported", notes: "interested in a bigger deck" }).category, null);
});

test("lifecycle categories flow through to the deterministic result", () => {
  const result = analyzeDeterministic(makeLead({ notes: "Went with another company in May." }), { now: NOW });
  assert.equal(result.category, "previously_lost");
});

// ---------- Category thresholds ----------

test("score thresholds bucket into hot / re-engage / nurture", () => {
  const hot = analyzeDeterministic(makeLead(), { now: NOW });
  assert.equal(hot.category, "hot_opportunity");
  const mid = analyzeDeterministic(makeLead({ estimatedValue: null, estimateDate: null, lastContactDate: "2026-03-01" }), { now: NOW });
  assert.equal(mid.category, "worth_reengaging");
  const cold = analyzeDeterministic(
    makeLead({ estimatedValue: null, estimateDate: null, consentStatus: "implied", firstContactDate: "2023-05-01", lastContactDate: "2023-06-01" }),
    { now: NOW },
  );
  assert.equal(cold.category, "long_term_nurture");
});

// ---------- Suppression precedence over AI ----------

test("AI output can never override a stored suppression", () => {
  const lead = makeLead({ suppressed: true });
  const det = analyzeDeterministic(lead, { now: NOW });
  const merged = mergeAnalysis(det, makeAi({ score: 98, category: "hot_opportunity" }), lead);
  assert.equal(merged.category, "do_not_contact");
  assert.equal(merged.score, 0);
  assert.equal(merged.recommendedChannel, "none");
});

test("AI output can never override a stored opt-out", () => {
  const lead = makeLead({ consentStatus: "opted_out" });
  const det = analyzeDeterministic(lead, { now: NOW });
  const merged = mergeAnalysis(det, makeAi({ score: 91 }), lead);
  assert.equal(merged.category, "do_not_contact");
  assert.equal(merged.score, 0);
});

test("AI claiming do_not_contact without stored records goes to human review, not suppression", () => {
  const lead = makeLead();
  const det = analyzeDeterministic(lead, { now: NOW });
  const merged = mergeAnalysis(det, makeAi({ category: "do_not_contact", recommendedChannel: "none" }), lead);
  assert.equal(merged.category, "needs_manual_review");
  assert.equal(merged.needsReview, true);
  assert.ok(merged.riskFlags.includes("ai_suggested_do_not_contact"));
});

// ---------- Hybrid merge behavior ----------

test("hybrid score averages deterministic and AI scores", () => {
  const lead = makeLead();
  const det = analyzeDeterministic(lead, { now: NOW });
  const merged = mergeAnalysis(det, makeAi({ score: det.score + 10 }), lead);
  assert.equal(merged.mode, "hybrid");
  assert.equal(merged.score, Math.round((det.score + det.score + 10) / 2));
  assert.equal(merged.category, "hot_opportunity");
});

test("low AI confidence forces manual review", () => {
  const lead = makeLead();
  const det = analyzeDeterministic(lead, { now: NOW });
  const merged = mergeAnalysis(det, makeAi({ confidence: 0.3 }), lead);
  assert.equal(merged.category, "needs_manual_review");
  assert.ok(merged.reviewReasons.some((r) => /confidence/i.test(r)));
});

test("strong AI/deterministic disagreement forces manual review", () => {
  const lead = makeLead({ estimatedValue: null, estimateDate: null, lastContactDate: "2024-01-01" });
  const det = analyzeDeterministic(lead, { now: NOW });
  const merged = mergeAnalysis(det, makeAi({ score: det.score + 40 }), lead);
  assert.equal(merged.category, "needs_manual_review");
});

test("without AI, the deterministic result stands (fallback mode)", () => {
  const lead = makeLead();
  const det = analyzeDeterministic(lead, { now: NOW });
  const merged = mergeAnalysis(det, null, lead);
  assert.equal(merged.mode, "deterministic");
  assert.equal(merged.score, det.score);
  assert.equal(merged.category, det.category);
});

// ---------- AI schema validation ----------

test("valid AI analysis passes schema validation", () => {
  const parsed = parseAiAnalysis(JSON.stringify(makeAi()));
  assert.equal(parsed.score, 85);
  assert.equal(parsed.category, "hot_opportunity");
});

test("out-of-range or malformed AI analysis is rejected", () => {
  assert.throws(() => parseAiAnalysis(makeAi({ score: 150 })), /schema validation/);
  assert.throws(() => parseAiAnalysis(makeAi({ score: 12.5 })), /schema validation/);
  assert.throws(() => parseAiAnalysis(makeAi({ category: "amazing_lead" })), /schema validation/);
  assert.throws(() => parseAiAnalysis(makeAi({ confidence: 2 })), /schema validation/);
  assert.throws(() => parseAiAnalysis(makeAi({ recommendedChannel: "carrier_pigeon" })), /schema validation/);
  assert.throws(() => parseAiAnalysis({ score: 50 }), /schema validation/);
});

test("extractJsonObject tolerates code fences and surrounding prose", () => {
  const wrapped = "Sure! Here is the JSON:\n```json\n{\"a\": 1}\n```";
  assert.deepEqual(extractJsonObject(wrapped), { a: 1 });
  assert.throws(() => extractJsonObject("no json here"));
});

test("all nine spec categories exist and validate", () => {
  assert.equal(LEAD_CATEGORIES.length, 9);
  for (const category of LEAD_CATEGORIES) {
    assert.ok(isLeadCategory(category));
    assert.doesNotThrow(() => parseAiAnalysis(makeAi({ category })));
  }
});

// ---------- Message drafts ----------

test("message request schema validates type and tone", () => {
  assert.equal(messageRequestSchema.parse({ type: "sms" }).tone, "professional");
  assert.throws(() => messageRequestSchema.parse({ type: "carrier_pigeon" }));
  assert.throws(() => messageRequestSchema.parse({ type: "sms", tone: "aggressive" }));
});

test("fact sheet lists known facts and explicitly names missing ones", () => {
  const facts = buildLeadFactSheet(makeLead({ projectType: null, estimatedValue: null }));
  assert.ok(facts.known.some((line) => line.startsWith("First name: Maria")));
  assert.ok(facts.missing.includes("Project type"));
  assert.ok(facts.missing.includes("Estimated value"));
});

test("template SMS uses only stored facts and includes opt-out language", () => {
  const lead = makeLead({ projectType: null, estimateDate: null });
  const draft = buildTemplateDraft("sms", lead, { orgName: "Acme Roofing", tone: "professional", includeOptOutLanguage: true });
  assert.ok(draft.body.includes("Maria"));
  assert.ok(draft.body.includes("Acme Roofing"));
  assert.ok(draft.body.endsWith(SMS_OPT_OUT));
  // No invented specifics: with projectType missing it falls back to generic wording.
  assert.ok(draft.body.includes("the project you inquired about"));
  assert.ok(!/\$\d/.test(draft.body), "must not invent a price");
});

test("template drafts degrade gracefully when the name is missing", () => {
  const lead = makeLead({ firstName: null, lastName: null });
  const sms = buildTemplateDraft("sms", lead, { orgName: "Acme", tone: "friendly", includeOptOutLanguage: false });
  assert.ok(sms.body.startsWith("Hi there"));
  assert.ok(!sms.body.includes(SMS_OPT_OUT));
});

test("template sequence only uses channels the lead can actually receive", () => {
  const emailOnly = makeLead({ phoneNormalized: null, phone: null });
  const draft = buildTemplateDraft("sequence", emailOnly, { orgName: "Acme", tone: "professional", includeOptOutLanguage: true });
  assert.ok(draft.steps.length >= 2);
  assert.ok(draft.steps.every((step) => step.channel !== "sms"));
});

test("every template draft validates against its own content schema", () => {
  const lead = makeLead();
  for (const type of ["sms", "email", "call_script", "voicemail", "follow_up_note", "sequence"]) {
    const draft = buildTemplateDraft(type, lead, { orgName: "Acme", tone: "urgent", includeOptOutLanguage: true });
    assert.doesNotThrow(() => parseMessageContent(type, draft), `template ${type} failed its schema`);
  }
});

test("invalid generated content is rejected by the per-type schemas", () => {
  assert.throws(() => parseMessageContent("sms", { body: "" }));
  assert.throws(() => parseMessageContent("email", { body: "no subject" }));
  assert.throws(() => parseMessageContent("sequence", { steps: [{ channel: "fax", delayDays: 1, body: "x" }] }));
  assert.throws(() => parseMessageContent("sequence", { steps: [] }));
});

test("unknown consent yields an SMS compliance warning", () => {
  const warnings = draftWarnings({ consentStatus: "unknown" }, "sms");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /consent/i);
  assert.deepEqual(draftWarnings({ consentStatus: "express" }, "sms"), []);
  assert.deepEqual(draftWarnings({ consentStatus: "unknown" }, "email"), []);
});
