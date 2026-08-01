import { z } from "zod";
import { LEAD_CATEGORIES } from "./categories.ts";

/**
 * Structured-output contract for the AI analysis pass. Every model response is
 * validated against this schema before anything is stored — invalid output is
 * rejected and retried, then the lead falls back to deterministic-only mode.
 * Pure module.
 */

export const AI_INTENTS = ["high", "medium", "low", "unknown"] as const;
export const AI_CHANNELS = ["sms", "email", "call", "none"] as const;

export const aiAnalysisSchema = z.object({
  score: z.number().int().min(0).max(100),
  category: z.enum(LEAD_CATEGORIES),
  intent: z.enum(AI_INTENTS),
  reasonStalled: z.string().trim().min(1).max(600),
  recommendedChannel: z.enum(AI_CHANNELS),
  recommendedAction: z.string().trim().min(1).max(400),
  recommendedAngle: z.string().trim().min(1).max(400),
  summary: z.string().trim().min(1).max(1000),
  confidence: z.number().min(0).max(1),
  riskFlags: z.array(z.string().trim().max(160)).max(12).default([]),
});

export type AiAnalysis = z.infer<typeof aiAnalysisSchema>;

/** JSON shape description embedded in the prompt (kept in sync with the schema above). */
export const AI_ANALYSIS_JSON_SPEC = `{
  "score": <integer 0-100>,
  "category": <one of ${JSON.stringify(LEAD_CATEGORIES)}>,
  "intent": <one of ${JSON.stringify(AI_INTENTS)}>,
  "reasonStalled": <string — most likely reason this lead went quiet, based only on provided facts>,
  "recommendedChannel": <one of ${JSON.stringify(AI_CHANNELS)}>,
  "recommendedAction": <string — the single next step a rep should take>,
  "recommendedAngle": <string — the re-engagement angle to lead with>,
  "summary": <string — 2-3 sentence plain-language assessment>,
  "confidence": <number 0-1>,
  "riskFlags": <array of short strings, empty when none>
}`;

/** Pulls the first JSON object out of a model reply (tolerates code fences / prose). */
export function extractJsonObject(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("No JSON object found in model output.");
  return JSON.parse(cleaned.slice(start, end + 1));
}

/** Validates raw model output; throws with a readable message when it does not conform. */
export function parseAiAnalysis(raw: unknown): AiAnalysis {
  const value = typeof raw === "string" ? extractJsonObject(raw) : raw;
  const result = aiAnalysisSchema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new Error(`AI analysis failed schema validation: ${first?.path.join(".")} ${first?.message}`);
  }
  return result.data;
}
