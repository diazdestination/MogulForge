import "server-only";
import { getOpenAIClient } from "../openai";
import { logAudit } from "../audit";
import { checkActionCapacity, recordUsageInBackground } from "../usage";
import { analyzeDeterministic, type DeterministicAnalysis } from "./signals.ts";
import { AI_ANALYSIS_JSON_SPEC, parseAiAnalysis, type AiAnalysis } from "./ai-schema.ts";
import { mergeAnalysis } from "./merge.ts";
import { buildLeadFactSheet } from "./message-content.ts";
import {
  deleteAnalysisRun,
  getActiveRun,
  getOrgServiceArea,
  listLeadsForAnalysis,
  markLeadAnalysisFailed,
  markLeadsAnalyzing,
  reapStaleRuns,
  reclaimStrandedLeads,
  saveLeadAnalysis,
  tryCreateAnalysisRun,
  updateRunProgress,
  type AnalysisRun,
  type LeadForAnalysis,
} from "./store.ts";

/**
 * Batch analysis engine. Deterministic signals always run; when the OpenAI key
 * is configured each contactable lead also gets a structured AI pass (validated
 * against a schema, retried once, deterministic-only fallback on failure).
 * Suppressed / opted-out leads never reach the model at all.
 */

/** Cap per run — keeps a single background run bounded; the next run picks up the rest. */
export const MAX_LEADS_PER_RUN = 500;
const AI_BATCH_SIZE = 4;
const AI_ATTEMPTS = 2;

const ANALYSIS_INSTRUCTIONS = [
  "You are MogulForge's lead re-engagement analyst for home-service contractors.",
  "Assess ONE dormant lead using ONLY the facts provided. Never invent facts; when data is missing, be conservative and say so.",
  "You do not decide consent: suppression and opt-outs are enforced elsewhere from stored records. Focus on opportunity quality.",
  "Category definitions: hot_opportunity (strong recent intent + value), worth_reengaging (real potential, needs a nudge), long_term_nurture (weak or old, keep warm), needs_manual_review (contradictory or insufficient data), invalid_duplicate (unusable record), do_not_contact (only when the provided facts themselves show an opt-out), previously_lost (chose a competitor or explicitly lost), existing_customer (already bought/completed a job), no_longer_qualified (moved, sold home, out of area, or otherwise ineligible).",
  "Return ONLY valid JSON matching the requested shape. No prose, no markdown.",
].join(" ");

async function runAiAnalysis(lead: LeadForAnalysis, deterministic: DeterministicAnalysis, serviceArea: string | null): Promise<AiAnalysis> {
  const facts = buildLeadFactSheet(lead);
  const input = [
    `Return JSON with this exact shape:\n${AI_ANALYSIS_JSON_SPEC}`,
    serviceArea ? `Business service area: ${serviceArea}` : "Business service area: not stated.",
    `Known lead facts:\n- ${facts.known.join("\n- ")}`,
    facts.missing.length > 0 ? `Fields with NO data on record (do not guess these): ${facts.missing.join(", ")}` : null,
    `Deterministic rules-based pre-score: ${deterministic.score}/100 (category ${deterministic.category}). Signals: ${deterministic.signals.map((s) => `${s.label} (${s.points >= 0 ? "+" : ""}${s.points})`).join("; ")}.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  let lastError: unknown;
  for (let attempt = 1; attempt <= AI_ATTEMPTS; attempt++) {
    try {
      const response = await getOpenAIClient().responses.create({
        model: process.env.OPENAI_MODEL ?? "gpt-5.6-luna",
        instructions: ANALYSIS_INSTRUCTIONS,
        input,
        text: { verbosity: "low" },
      });
      return parseAiAnalysis(response.output_text);
    } catch (error) {
      lastError = error;
      if (attempt < AI_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("AI analysis failed.");
}

async function analyzeOneLead(
  organizationId: string,
  lead: LeadForAnalysis,
  serviceArea: string | null,
  aiEnabled: boolean,
): Promise<{ usedAi: boolean }> {
  const deterministic = analyzeDeterministic(lead, { now: new Date(), serviceArea });

  // Suppressed / opted-out / unreachable leads are decided by rules alone —
  // no model call is made for them (consent is never an AI decision).
  const skipAi = lead.suppressed || lead.consentStatus === "opted_out" || deterministic.category === "invalid_duplicate";

  let ai: AiAnalysis | null = null;
  let aiError: string | null = null;
  if (aiEnabled && !skipAi) {
    try {
      ai = await runAiAnalysis(lead, deterministic, serviceArea);
    } catch (error) {
      aiError = error instanceof Error ? error.message : String(error);
      console.error("AI analysis failed for lead", lead.id, aiError);
    }
  }

  const final = mergeAnalysis(deterministic, ai, lead);
  await saveLeadAnalysis(organizationId, lead.id, {
    mode: final.mode,
    deterministic: { score: deterministic.score, category: deterministic.category, signals: deterministic.signals, flags: deterministic.flags },
    ai,
    aiError,
    final,
    analyzedAt: new Date().toISOString(),
  });
  return { usedAi: !!ai };
}

async function processRun(run: AnalysisRun, leads: LeadForAnalysis[], actorLabel: string): Promise<void> {
  const organizationId = run.organizationId;
  let analyzed = 0;
  let aiCount = 0;
  let failed = 0;
  try {
    const serviceArea = await getOrgServiceArea(organizationId);
    const aiEnabled = !!process.env.OPENAI_API_KEY;

    for (let i = 0; i < leads.length; i += AI_BATCH_SIZE) {
      const batch = leads.slice(i, i + AI_BATCH_SIZE);
      await markLeadsAnalyzing(organizationId, batch.map((lead) => lead.id));
      const results = await Promise.allSettled(batch.map((lead) => analyzeOneLead(organizationId, lead, serviceArea, aiEnabled)));
      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status === "fulfilled") {
          analyzed++;
          if (result.value.usedAi) aiCount++;
        } else {
          failed++;
          const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
          console.error("Lead analysis failed", batch[j].id, message);
          await markLeadAnalysisFailed(organizationId, batch[j].id, "Analysis failed unexpectedly. Re-run analysis to retry this lead.").catch(() => {});
        }
      }
      // Persist progress after every batch so the dashboard can poll it.
      await updateRunProgress(organizationId, run.id, { analyzedCount: analyzed, aiCount, failedCount: failed });
    }

    if (analyzed > 0) recordUsageInBackground(organizationId, "leads_analyzed", analyzed);
    const status = failed === 0 ? "complete" : analyzed === 0 ? "failed" : "partial";
    await updateRunProgress(organizationId, run.id, {
      status,
      analyzedCount: analyzed,
      aiCount,
      failedCount: failed,
      error: status === "failed" ? "Every lead in this run failed to analyze. Re-run analysis to retry." : null,
    });
    await logAudit({
      organizationId,
      actorLabel,
      action: "lead_analysis.completed",
      targetType: "lead_analysis_run",
      targetId: run.id,
      metadata: { status, totalCount: run.totalCount, analyzedCount: analyzed, aiCount, failedCount: failed },
    });
  } catch (error) {
    console.error("Analysis run failed", run.id, error);
    await updateRunProgress(organizationId, run.id, {
      status: "failed",
      analyzedCount: analyzed,
      aiCount,
      failedCount: failed,
      error: "Analysis run failed unexpectedly. You can start a new run safely.",
    }).catch(() => {});
    await logAudit({
      organizationId,
      actorLabel,
      action: "lead_analysis.failed",
      targetType: "lead_analysis_run",
      targetId: run.id,
      metadata: { message: error instanceof Error ? error.message : String(error) },
    });
  }
}

export type StartRunResult =
  | { started: true; run: AnalysisRun }
  | { started: false; reason: "run_in_progress"; activeRun: AnalysisRun | null }
  | { started: false; reason: "no_leads" }
  | { started: false; reason: "usage_blocked"; message: string };

/**
 * Starts a background analysis run over the org's pending/failed leads
 * (optionally scoped to one import).
 *
 * Reliability guarantees:
 * - One active run per org, enforced by a partial unique index — concurrent
 *   starts (e.g. a manual POST racing the post-import auto-start) resolve
 *   atomically in the database: exactly one wins, the other gets 409.
 * - Interrupted runs are reaped (marked failed after STALE_RUN_MINUTES with no
 *   progress) and their leads stranded in 'analyzing' return to 'pending', so
 *   a crash or restart can never permanently strand a lead.
 */
export async function startAnalysisRun(
  organizationId: string,
  opts: { importId?: string | null; createdBy?: string | null; actorLabel: string },
): Promise<StartRunResult> {
  // Usage gate enforced here — the shared entry point — so every caller
  // (manual API route AND the post-import auto-start) is covered.
  const capacity = await checkActionCapacity(organizationId, { ai_jobs: 1 });
  if (!capacity.allowed) {
    return { started: false, reason: "usage_blocked", message: capacity.reason ?? "AI analysis limit reached for this plan." };
  }

  // Recover from any interrupted previous run before trying to start.
  await reapStaleRuns(organizationId);
  await reclaimStrandedLeads(organizationId);

  // Atomic claim: the partial unique index allows at most one 'running' row
  // per org, so exactly one concurrent caller gets a run back.
  const run = await tryCreateAnalysisRun({
    organizationId,
    importId: opts.importId ?? null,
    createdBy: opts.createdBy ?? null,
    mode: process.env.OPENAI_API_KEY ? "hybrid" : "deterministic",
    totalCount: 0,
  });
  if (!run) {
    return { started: false, reason: "run_in_progress", activeRun: await getActiveRun(organizationId) };
  }

  const leads = await listLeadsForAnalysis(organizationId, { importId: opts.importId ?? null, limit: MAX_LEADS_PER_RUN });
  if (leads.length === 0) {
    await deleteAnalysisRun(organizationId, run.id);
    return { started: false, reason: "no_leads" };
  }
  await updateRunProgress(organizationId, run.id, { totalCount: leads.length });
  run.totalCount = leads.length;
  recordUsageInBackground(organizationId, "ai_jobs", 1);

  void processRun(run, leads, opts.actorLabel).catch((error) => {
    console.error("Unhandled analysis run error", run.id, error);
  });
  return { started: true, run };
}
