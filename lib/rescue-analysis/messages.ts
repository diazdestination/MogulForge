import "server-only";
import { getOpenAIClient } from "../openai";
import type { LeadForAnalysis } from "./store.ts";
import {
  buildLeadFactSheet,
  buildTemplateDraft,
  draftWarnings,
  parseMessageContent,
  EMAIL_OPT_OUT,
  SMS_OPT_OUT,
  type MessageRequest,
  type MessageType,
} from "./message-content.ts";

/**
 * Server-side message generation. Drafts are built strictly from stored lead
 * facts — the prompt forbids fabrication and the output is validated against a
 * per-type schema. When the model fails (or no key is configured) a
 * deterministic template draft is produced instead. Nothing here sends —
 * sending, approval, and simulation belong to the campaigns module.
 */

export class SuppressedLeadError extends Error {
  constructor() {
    super("This lead is suppressed or opted out. Message generation is disabled by stored consent records.");
  }
}

const CONTENT_SPECS: Record<MessageType, string> = {
  sms: `{"body": <string, max 320 chars, a single SMS>}`,
  email: `{"subject": <string>, "body": <string, plain text, short paragraphs>}`,
  call_script: `{"opening": <string>, "talkingPoints": [<2-6 strings>], "objectionResponses": [{"objection": <string>, "response": <string>}, ... up to 4], "closing": <string>}`,
  voicemail: `{"script": <string, ~20 seconds when read aloud>}`,
  follow_up_note: `{"note": <string, an internal CRM note for the rep, not customer-facing>}`,
  sequence: `{"steps": [{"channel": "sms"|"email"|"call", "delayDays": <int 0-60>, "subject": <string or null, email only>, "body": <string>}, ... 3-5 steps]}`,
};

function generationInstructions(request: MessageRequest, orgName: string): string {
  return [
    `You write re-engagement outreach for ${orgName}, a home-services business, aimed at dormant leads.`,
    "STRICT RULES:",
    "1. Use ONLY the facts listed under 'Known lead facts'. NEVER invent names, prices, dates, addresses, project details, or past conversations.",
    "2. For any field listed as missing, use conservative generic language (e.g. 'your project') instead of guessing.",
    "3. Do not promise discounts, timelines, or outcomes.",
    `4. Tone: ${request.tone}.`,
    request.includeOptOutLanguage
      ? `5. Opt-out language is REQUIRED: end any SMS with "${SMS_OPT_OUT}" and any email with a line like "${EMAIL_OPT_OUT}".`
      : "5. Do not add opt-out boilerplate.",
    "Return ONLY valid JSON matching the requested shape. No prose, no markdown.",
  ].join("\n");
}

async function runAiGeneration(lead: LeadForAnalysis, request: MessageRequest, orgName: string): Promise<Record<string, unknown>> {
  const facts = buildLeadFactSheet(lead);
  const input = [
    `Draft a ${request.type.replaceAll("_", " ")} and return JSON with this exact shape:\n${CONTENT_SPECS[request.type]}`,
    `Known lead facts:\n- ${facts.known.join("\n- ")}`,
    facts.missing.length > 0 ? `Fields with NO data on record (write around these, never guess): ${facts.missing.join(", ")}` : null,
    request.objective?.trim() ? `Objective for this message: ${request.objective.trim()}` : "Objective: reopen the conversation and learn where the project stands.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const response = await getOpenAIClient().responses.create({
    model: process.env.OPENAI_MODEL ?? "gpt-5.6-luna",
    instructions: generationInstructions(request, orgName),
    input,
    text: { verbosity: "low" },
  });
  const raw = JSON.parse(
    response.output_text.replace(/```(?:json)?/gi, "").trim(),
  );
  return parseMessageContent(request.type, raw);
}

export type GeneratedDraft = {
  mode: "ai" | "template";
  content: Record<string, unknown>;
  warnings: string[];
};

/**
 * Generates one draft for a lead. Throws SuppressedLeadError for suppressed or
 * opted-out leads — suppression precedes everything, including generation.
 */
export async function generateMessageDraft(
  lead: LeadForAnalysis,
  request: MessageRequest,
  orgName: string,
): Promise<GeneratedDraft> {
  if (lead.suppressed || lead.consentStatus === "opted_out") throw new SuppressedLeadError();

  const warnings = draftWarnings(lead, request.type);
  if (!lead.emailNormalized && !lead.phoneNormalized) {
    warnings.push("No valid contact channel on record — this draft cannot be delivered until the lead is fixed.");
  }

  const templateOptions = {
    orgName,
    tone: request.tone,
    objective: request.objective?.trim() || undefined,
    includeOptOutLanguage: request.includeOptOutLanguage,
  };

  if (!process.env.OPENAI_API_KEY) {
    return { mode: "template", content: buildTemplateDraft(request.type, lead, templateOptions), warnings };
  }

  try {
    const content = await runAiGeneration(lead, request, orgName);
    return { mode: "ai", content, warnings };
  } catch (error) {
    console.error("AI message generation failed; falling back to template", lead.id, error);
    return {
      mode: "template",
      content: buildTemplateDraft(request.type, lead, templateOptions),
      warnings: [...warnings, "AI generation was unavailable — this is a rules-based template draft."],
    };
  }
}
