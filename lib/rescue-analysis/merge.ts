import { type LeadCategory } from "./categories.ts";
import type { AiAnalysis } from "./ai-schema.ts";
import type { DeterministicAnalysis, LeadFacts } from "./signals.ts";

/**
 * Combines the deterministic signal pass with the (optional) AI pass into the
 * final stored analysis. Precedence rules, in order:
 *
 * 1. Suppression / opt-out from stored records always wins — the lead stays
 *    `do_not_contact` with score 0 no matter what the AI returned.
 * 2. Leads without a valid contact channel stay `invalid_duplicate`.
 * 3. If the AI claims `do_not_contact` but stored consent records do NOT — the
 *    AI is not allowed to decide consent; the lead is flagged for human review.
 * 4. Low AI confidence or a large disagreement with the deterministic score
 *    also routes the lead to human review.
 * 5. Otherwise the AI category is adopted and the final score is the average
 *    of both passes (hybrid). Without AI, the deterministic result stands.
 *
 * Pure module.
 */

export type FinalAnalysis = {
  mode: "hybrid" | "deterministic";
  score: number;
  category: LeadCategory;
  needsReview: boolean;
  riskFlags: string[];
  summary: string;
  intent: AiAnalysis["intent"] | null;
  reasonStalled: string | null;
  recommendedChannel: AiAnalysis["recommendedChannel"] | null;
  recommendedAction: string | null;
  recommendedAngle: string | null;
  confidence: number | null;
  reviewReasons: string[];
};

const LOW_CONFIDENCE_THRESHOLD = 0.5;
const DISAGREEMENT_THRESHOLD = 35;

export function mergeAnalysis(
  deterministic: DeterministicAnalysis,
  ai: AiAnalysis | null,
  facts: Pick<LeadFacts, "suppressed" | "consentStatus">,
): FinalAnalysis {
  const suppressed = facts.suppressed || facts.consentStatus === "opted_out";

  // Rule 1: stored suppression always wins.
  if (suppressed) {
    return {
      mode: ai ? "hybrid" : "deterministic",
      score: 0,
      category: "do_not_contact",
      needsReview: false,
      riskFlags: ["suppressed", ...(ai?.riskFlags ?? [])],
      summary: "This contact is on the do-not-contact list or opted out. Stored consent records block all outreach; AI output cannot override this.",
      intent: null,
      reasonStalled: null,
      recommendedChannel: "none",
      recommendedAction: "Do not contact. Keep the record for suppression history only.",
      recommendedAngle: null,
      confidence: null,
      reviewReasons: [],
    };
  }

  // Rule 2: unreachable leads stay invalid regardless of AI.
  if (deterministic.category === "invalid_duplicate") {
    return {
      mode: ai ? "hybrid" : "deterministic",
      score: 0,
      category: "invalid_duplicate",
      needsReview: false,
      riskFlags: deterministic.flags,
      summary: "No valid email or phone is on record, so this lead cannot be worked.",
      intent: null,
      reasonStalled: null,
      recommendedChannel: "none",
      recommendedAction: "Fix or enrich the contact info before this lead can be re-engaged.",
      recommendedAngle: null,
      confidence: null,
      reviewReasons: [],
    };
  }

  // Deterministic-only mode (no key, model failure, or invalid output).
  if (!ai) {
    return {
      mode: "deterministic",
      score: deterministic.score,
      category: deterministic.category,
      needsReview: deterministic.needsReview,
      riskFlags: deterministic.flags,
      summary: `Deterministic assessment: scored ${deterministic.score}/100 from ${deterministic.signals.length} recorded signals. AI analysis was unavailable, so this is a rules-only result.`,
      intent: null,
      reasonStalled: null,
      recommendedChannel: null,
      recommendedAction: null,
      recommendedAngle: null,
      confidence: null,
      reviewReasons: deterministic.needsReview ? ["Too many unknown fields for an automatic decision."] : [],
    };
  }

  const reviewReasons: string[] = [];
  if (deterministic.needsReview) reviewReasons.push("Deterministic pass found too many unknown fields.");
  if (ai.confidence < LOW_CONFIDENCE_THRESHOLD) reviewReasons.push(`AI confidence is low (${ai.confidence.toFixed(2)}).`);
  if (Math.abs(ai.score - deterministic.score) >= DISAGREEMENT_THRESHOLD) {
    reviewReasons.push(`AI score (${ai.score}) and deterministic score (${deterministic.score}) disagree strongly.`);
  }
  // Rule 3: AI cannot decide consent. Stored records say this lead is contactable.
  if (ai.category === "do_not_contact") {
    reviewReasons.push("AI suggested do-not-contact but stored consent records do not — a human must decide.");
  }

  const needsReview = reviewReasons.length > 0;
  const riskFlags = [...new Set([...deterministic.flags, ...ai.riskFlags, ...(ai.category === "do_not_contact" ? ["ai_suggested_do_not_contact"] : [])])];
  const score = Math.round((deterministic.score + ai.score) / 2);

  return {
    mode: "hybrid",
    score,
    category: needsReview ? "needs_manual_review" : ai.category,
    needsReview,
    riskFlags,
    summary: ai.summary,
    intent: ai.intent,
    reasonStalled: ai.reasonStalled,
    recommendedChannel: needsReview && ai.category === "do_not_contact" ? "none" : ai.recommendedChannel,
    recommendedAction: ai.recommendedAction,
    recommendedAngle: ai.recommendedAngle,
    confidence: ai.confidence,
    reviewReasons,
  };
}
