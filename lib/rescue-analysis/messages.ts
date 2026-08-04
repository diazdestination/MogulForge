import "server-only";
import { getOpenAIClient } from "../openai";
import type { LeadForAnalysis } from "./store.ts";
import {
  buildLeadFactSheet,
  buildTemplateDraft,
  draftWarnings,
  ensureOptOutLanguage,
  parseMessageContent,
  EMAIL_OPT_OUT,
  SMS_OPT_OUT,
  type MessageRequest,
  type MessageTone,
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

export type FollowUpAttemptContext = {
  /** Which touch this draft is (1 = first contact, 2+ = follow-ups). */
  attemptNumber: number;
  /** True when this is the last planned touch. */
  isFinalAttempt: boolean;
  maxAttempts: number;
  /** Booking URL the recipient can use to schedule directly, when configured. */
  bookingLink?: string;
};

function attemptPromptLines(attempt: FollowUpAttemptContext): string[] {
  const lines = [
    `This is automated follow-up attempt ${attempt.attemptNumber} of at most ${attempt.maxAttempts} for this lead — earlier outreach got no reply.`,
    "Do NOT repeat a generic first-touch introduction; acknowledge (without inventing details) that we've reached out before.",
  ];
  if (attempt.isFinalAttempt) {
    lines.push("This is the FINAL planned touch: use a respectful 'last note before we close your file / quiet down' framing, and make clear one quick reply keeps things open.");
  } else if (attempt.attemptNumber === 2) {
    lines.push("Use a light 'just checking in' angle — brief, low pressure, easy to reply to.");
  } else {
    lines.push("Use a 'circling back' angle that acknowledges timing shifts and invites a one-line status update.");
  }
  lines.push("Keep the wording clearly different from what a previous attempt would have said.");
  if (attempt.bookingLink?.trim()) {
    lines.push(`A booking link is available — include it verbatim so they can grab a time directly: ${attempt.bookingLink.trim()}`);
  }
  return lines;
}

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

async function runAiGeneration(
  lead: LeadForAnalysis,
  request: MessageRequest,
  orgName: string,
  attempt?: FollowUpAttemptContext,
): Promise<Record<string, unknown>> {
  const facts = buildLeadFactSheet(lead);
  const input = [
    `Draft a ${request.type.replaceAll("_", " ")} and return JSON with this exact shape:\n${CONTENT_SPECS[request.type]}`,
    `Known lead facts:\n- ${facts.known.join("\n- ")}`,
    facts.missing.length > 0 ? `Fields with NO data on record (write around these, never guess): ${facts.missing.join(", ")}` : null,
    attempt ? attemptPromptLines(attempt).join("\n") : null,
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
  const content = parseMessageContent(request.type, raw);
  // Opt-out language is enforced on AI output, never trusted from the model.
  return request.includeOptOutLanguage ? ensureOptOutLanguage(request.type, content) : content;
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

/**
 * Attempt-aware draft for the automatic follow-up scheduler. When
 * OPENAI_API_KEY is configured the draft is AI-written with the attempt number
 * (and final-attempt framing) in the prompt, under the same fact-only rules as
 * one-off drafts; opt-out language is enforced on the output. Otherwise (or on
 * any AI failure) it falls back to the deterministic per-attempt template
 * variants, so scheduler sends never fail because of the model.
 */
export async function generateFollowUpDraft(
  lead: LeadForAnalysis,
  options: {
    channel: "sms" | "email";
    tone: MessageTone;
    objective?: string;
    attemptNumber: number;
    maxAttempts: number;
    bookingLink?: string;
  },
  orgName: string,
): Promise<GeneratedDraft> {
  if (lead.suppressed || lead.consentStatus === "opted_out") throw new SuppressedLeadError();

  const isFinalAttempt = options.attemptNumber >= options.maxAttempts;
  const templateOptions = {
    orgName,
    tone: options.tone,
    objective: options.objective?.trim() || undefined,
    includeOptOutLanguage: true,
    attemptNumber: options.attemptNumber,
    isFinalAttempt,
    bookingLink: options.bookingLink,
  };

  if (!process.env.OPENAI_API_KEY) {
    return { mode: "template", content: buildTemplateDraft(options.channel, lead, templateOptions), warnings: [] };
  }

  const request: MessageRequest = {
    type: options.channel,
    tone: options.tone,
    objective: options.objective?.trim() || undefined,
    includeOptOutLanguage: true,
  };
  try {
    const content = await runAiGeneration(lead, request, orgName, {
      attemptNumber: options.attemptNumber,
      isFinalAttempt,
      maxAttempts: options.maxAttempts,
      bookingLink: options.bookingLink,
    });
    return { mode: "ai", content, warnings: [] };
  } catch (error) {
    console.error("AI follow-up generation failed; falling back to template", lead.id, error);
    return { mode: "template", content: buildTemplateDraft(options.channel, lead, templateOptions), warnings: [] };
  }
}
