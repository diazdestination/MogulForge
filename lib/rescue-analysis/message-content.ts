import { z } from "zod";
import type { LeadFacts } from "./signals.ts";

/**
 * Message-draft contracts + deterministic template fallbacks. Pure module.
 *
 * The core safety rule for every generated draft: use ONLY facts stored on the
 * lead record. Anything missing is written around with conservative, generic
 * language — never invented. The AI prompt enforces this and the template
 * fallbacks below are constructed the same way.
 */

export const MESSAGE_TYPES = ["sms", "email", "call_script", "voicemail", "follow_up_note", "sequence"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const MESSAGE_TYPE_LABELS: Record<MessageType, string> = {
  sms: "Text message (SMS)",
  email: "Email",
  call_script: "Call script",
  voicemail: "Voicemail script",
  follow_up_note: "Follow-up note",
  sequence: "Multi-step sequence",
};

export const MESSAGE_TONES = ["professional", "friendly", "urgent"] as const;
export type MessageTone = (typeof MESSAGE_TONES)[number];

export const messageRequestSchema = z.object({
  type: z.enum(MESSAGE_TYPES),
  tone: z.enum(MESSAGE_TONES).default("professional"),
  objective: z.string().trim().max(300).optional().or(z.literal("")),
  includeOptOutLanguage: z.boolean().default(true),
});
export type MessageRequest = z.infer<typeof messageRequestSchema>;

// ---- Per-type content schemas (AI output is validated against these) -------

const sequenceStepSchema = z.object({
  channel: z.enum(["sms", "email", "call"]),
  delayDays: z.number().int().min(0).max(60),
  subject: z.string().trim().max(150).nullable().optional(),
  body: z.string().trim().min(1).max(4000),
});

export const MESSAGE_CONTENT_SCHEMAS: Record<MessageType, z.ZodTypeAny> = {
  sms: z.object({ body: z.string().trim().min(1).max(480) }),
  email: z.object({ subject: z.string().trim().min(1).max(150), body: z.string().trim().min(1).max(4000) }),
  call_script: z.object({
    opening: z.string().trim().min(1).max(1000),
    talkingPoints: z.array(z.string().trim().min(1).max(500)).min(1).max(8),
    objectionResponses: z.array(z.object({ objection: z.string().trim().min(1).max(300), response: z.string().trim().min(1).max(600) })).max(6),
    closing: z.string().trim().min(1).max(1000),
  }),
  voicemail: z.object({ script: z.string().trim().min(1).max(1200) }),
  follow_up_note: z.object({ note: z.string().trim().min(1).max(2000) }),
  sequence: z.object({ steps: z.array(sequenceStepSchema).min(2).max(6) }),
};

/** Validates raw (AI-produced) draft content for a message type. Throws on mismatch. */
export function parseMessageContent(type: MessageType, raw: unknown): Record<string, unknown> {
  const result = MESSAGE_CONTENT_SCHEMAS[type].safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new Error(`Generated ${type} draft failed validation: ${first?.path.join(".")} ${first?.message}`);
  }
  return result.data as Record<string, unknown>;
}

// ---- Fact sheet -------------------------------------------------------------

export type LeadFactSheet = { known: string[]; missing: string[] };

/** Lists exactly what is (and is not) known about a lead — the only material drafts may use. */
export function buildLeadFactSheet(facts: LeadFacts): LeadFactSheet {
  const known: string[] = [];
  const missing: string[] = [];
  const add = (label: string, value: string | null | undefined) => {
    if (value && String(value).trim() !== "") known.push(`${label}: ${String(value).trim()}`);
    else missing.push(label);
  };
  add("First name", facts.firstName);
  add("Last name", facts.lastName);
  add("Email", facts.email);
  add("Phone", facts.phone);
  add("City", facts.city);
  add("State", facts.state);
  add("Project type", facts.projectType);
  add("Project description", facts.projectDescription);
  add("Estimated value", facts.estimatedValue != null ? `$${facts.estimatedValue.toLocaleString()}` : null);
  add("Lead source", facts.source);
  add("First contact date", facts.firstContactDate);
  add("Last contact date", facts.lastContactDate);
  add("Estimate date", facts.estimateDate);
  add("Notes", facts.notes);
  known.push(`Consent status: ${facts.consentStatus}`);
  return { known, missing };
}

// ---- Opt-out language --------------------------------------------------------

export const SMS_OPT_OUT = "Reply STOP to opt out.";
export const EMAIL_OPT_OUT = "If you'd rather not hear from us, just reply \"unsubscribe\" and we'll remove you right away.";

/**
 * Enforces mandatory opt-out language on a draft AFTER schema validation.
 * AI output is never trusted to include it — if the required phrasing is
 * missing from an SMS or email body, it is appended deterministically.
 * Non-conversational types (call scripts, notes, …) pass through unchanged.
 */
export function ensureOptOutLanguage(type: MessageType, content: Record<string, unknown>): Record<string, unknown> {
  if (type === "sms") {
    const body = String(content.body ?? "");
    if (body.toLowerCase().includes("reply stop")) return content;
    return parseMessageContent("sms", { body: `${body.trim()} ${SMS_OPT_OUT}`.trim() });
  }
  if (type === "email") {
    const body = String(content.body ?? "");
    const lower = body.toLowerCase();
    if (lower.includes("unsubscribe") || lower.includes("opt out") || lower.includes("opt-out")) return content;
    return parseMessageContent("email", { subject: String(content.subject ?? ""), body: `${body.trimEnd()}\n\n${EMAIL_OPT_OUT}` });
  }
  if (type === "sequence") {
    const steps = Array.isArray(content.steps) ? content.steps : [];
    const fixed = steps.map((step: Record<string, unknown>) => {
      const channel = String(step.channel ?? "");
      if (channel === "sms") {
        const body = String(step.body ?? "");
        if (body.toLowerCase().includes("reply stop")) return step;
        return { ...step, body: `${body.trim()} ${SMS_OPT_OUT}`.trim() };
      }
      if (channel === "email") {
        const body = String(step.body ?? "");
        const lower = body.toLowerCase();
        if (lower.includes("unsubscribe") || lower.includes("opt out") || lower.includes("opt-out")) return step;
        return { ...step, body: `${body.trimEnd()}\n\n${EMAIL_OPT_OUT}` };
      }
      // call steps pass through unchanged
      return step;
    });
    return parseMessageContent("sequence", { steps: fixed });
  }
  return content;
}
/** Compliance warnings surfaced with a draft (never blocking — suppression blocks earlier). */
export function draftWarnings(facts: Pick<LeadFacts, "consentStatus">, type: MessageType): string[] {
  const warnings: string[] = [];
  if (facts.consentStatus === "unknown" && (type === "sms" || type === "sequence")) {
    warnings.push("Consent status is unknown — verify SMS eligibility before this draft is ever sent.");
  }
  if (facts.consentStatus === "implied" && type === "sms") {
    warnings.push("Consent is implied, not express — confirm your jurisdiction allows SMS on implied consent.");
  }
  return warnings;
}

// ---- Deterministic template fallbacks ----------------------------------------

export type TemplateOptions = {
  orgName: string;
  tone: MessageTone;
  objective?: string;
  includeOptOutLanguage: boolean;
  /**
   * Which touch this draft is (1 = first contact). Attempts 2+ get distinct
   * wording so repeat follow-ups never read identical to the first touch.
   */
  attemptNumber?: number;
  /** True when this is the last planned touch — uses "closing the file" framing. */
  isFinalAttempt?: boolean;
  /**
   * Fully-resolved booking URL for this recipient (already interpolated —
   * never a raw placeholder). When present, SMS and email drafts include a
   * booking call-to-action line.
   */
  bookingLink?: string;
};

function greetName(facts: LeadFacts): string {
  return facts.firstName?.trim() || "there";
}

function projectRef(facts: LeadFacts): string {
  return facts.projectType?.trim() ? `your ${facts.projectType.trim().toLowerCase()} project` : "the project you inquired about";
}

function estimateRef(facts: LeadFacts): string | null {
  if (!facts.estimateDate) return null;
  return `the estimate we prepared for you`;
}

function urgencyLine(tone: MessageTone): string {
  if (tone === "urgent") return "Our schedule is filling up, so now is a good time to reconnect.";
  if (tone === "friendly") return "No pressure at all — just checking in.";
  return "Happy to pick things back up whenever you are ready.";
}

/**
 * Rules-only drafts used when AI is unavailable. Built exclusively from stored
 * facts with conservative fallbacks for anything missing.
 */
/**
 * Which wording variant an attempt uses: attempt 1 is the standard first
 * touch, intermediate attempts alternate between a lighter "just checking in"
 * and a "circling back" nudge, and only the true final attempt gets the
 * "closing the file" note. Every variant keeps opt-out language when requested.
 */
function attemptVariant(opts: TemplateOptions): "first" | "checkin" | "nudge" | "closing" {
  const attempt = opts.attemptNumber ?? 1;
  if (opts.isFinalAttempt) return "closing";
  if (attempt <= 1) return "first";
  // Intermediate touches alternate between two angles so back-to-back
  // follow-ups never read the same (attempt 2 → checkin, 3 → nudge, 4 → checkin, …).
  return attempt % 2 === 0 ? "checkin" : "nudge";
}

export function buildTemplateDraft(type: MessageType, facts: LeadFacts, opts: TemplateOptions): Record<string, unknown> {
  const name = greetName(facts);
  const project = projectRef(facts);
  const estimate = estimateRef(facts);
  const followLine = estimate ? `We wanted to follow up on ${estimate} for ${project}.` : `We wanted to follow up on ${project}.`;
  const variant = attemptVariant(opts);

  switch (type) {
    case "sms": {
      const core =
        variant === "closing"
          ? [`Hi ${name}, ${opts.orgName} here — this is our last note about ${project}.`, "If we don't hear back we'll close your file, but one quick reply keeps it open."]
          : variant === "checkin"
            ? [`Hi ${name}, just checking in from ${opts.orgName} about ${project}.`, "Any update on your end? Happy to answer questions."]
            : variant === "nudge"
              ? [`Hi ${name}, ${opts.orgName} circling back on ${project}.`, "Timing shifts all the time — want us to keep it on our radar, or has anything changed?"]
              : [`Hi ${name}, this is ${opts.orgName}.`, followLine, "Is this still something you're considering?"];
      const booking = opts.bookingLink?.trim() ? `Grab a time that works for you: ${opts.bookingLink.trim()}` : null;
      const optOut = opts.includeOptOutLanguage ? SMS_OPT_OUT : null;
      let body = [...core, booking, optOut].filter(Boolean).join(" ");
      // Signed per-lead /book/<token> booking URLs are long; when the booking
      // line pushes the SMS past the 480-char cap, fall back to a compact body
      // rather than failing validation (the link and opt-out always survive).
      if (body.length > 480 && booking) {
        body = [`Hi ${name}, this is ${opts.orgName} about ${project}.`, booking, optOut].filter(Boolean).join(" ");
      }
      return parseMessageContent("sms", { body });
    }
    case "email": {
      const projectLabel = facts.projectType?.trim() ? `your ${facts.projectType.trim().toLowerCase()} project` : "your project inquiry";
      const subject =
        variant === "closing"
          ? `Should we close your file on ${projectLabel}?`
          : variant === "checkin"
            ? `Just checking in on ${projectLabel}`
            : variant === "nudge"
              ? `Circling back on ${projectLabel}`
              : facts.projectType?.trim()
                ? `Following up on your ${facts.projectType.trim().toLowerCase()} project`
                : "Following up on your project inquiry";
      const opener =
        variant === "closing"
          ? `This is the team at ${opts.orgName}. We've reached out a couple of times about ${project} and haven't heard back, so this is our last note before we quiet down and close your file.`
          : variant === "checkin"
            ? `This is the team at ${opts.orgName}, just checking in on ${project}. No news needed on our side — we simply didn't want it to slip through the cracks.`
            : variant === "nudge"
              ? `This is the team at ${opts.orgName}, circling back on ${project}. Timing shifts all the time — if plans changed, a one-line reply helps us keep your file accurate; if it's still in the works, we're ready when you are.`
              : `This is the team at ${opts.orgName}. ${followLine} We know priorities shift, so we wanted to check whether it's still on your list.`;
      const closerLine =
        variant === "closing"
          ? "If the timing isn't right, no reply needed — we'll step back. If it's still on your list, one quick reply reopens the conversation."
          : "If you have questions or anything has changed, just reply to this email — we're glad to help either way.";
      const body = [
        `Hi ${name},`,
        "",
        opener,
        variant === "closing" ? null : urgencyLine(opts.tone),
        "",
        closerLine,
        opts.bookingLink?.trim() ? `\nWhen you're ready, you can book a time directly here: ${opts.bookingLink.trim()}` : null,
        "",
        `— The ${opts.orgName} team`,
        opts.includeOptOutLanguage ? `\n${EMAIL_OPT_OUT}` : null,
      ]
        .filter((line) => line !== null)
        .join("\n");
      return parseMessageContent("email", { subject, body });
    }
    case "call_script":
      return parseMessageContent("call_script", {
        opening: `Hi, may I speak with ${facts.firstName?.trim() || "the homeowner"}? This is ${opts.orgName} calling about ${project}. Is now an okay time for a quick minute?`,
        talkingPoints: [
          `Reference what we know: ${estimate ? "an estimate is on file" : "they previously inquired"}${facts.lastContactDate ? `, last contact on ${facts.lastContactDate}` : ""}.`,
          "Ask an open question: \"Where did things land with the project?\" — then listen.",
          "If plans changed, ask what changed rather than assuming.",
          urgencyLine(opts.tone),
        ],
        objectionResponses: [
          { objection: "We went with someone else.", response: "Completely understand — thanks for letting us know. Would you like us to close out your file, or keep you on record for future work?" },
          { objection: "Not right now.", response: "No problem. Would it help if we checked back in a few months, or would you rather reach out when you're ready?" },
        ],
        closing: "Thanks for your time. If anything changes, you can reach us at this number. Have a great day.",
      });
    case "voicemail": {
      const script = [`Hi ${name}, this is ${opts.orgName}.`, followLine, "No rush — when you have a moment, give us a call back or reply to our earlier message. Thanks, and have a great day."].join(" ");
      return parseMessageContent("voicemail", { script });
    }
    case "follow_up_note": {
      const knownBits = [
        facts.projectType ? `Project: ${facts.projectType}` : null,
        facts.estimatedValue != null ? `Est. value: $${facts.estimatedValue.toLocaleString()}` : null,
        facts.lastContactDate ? `Last contact: ${facts.lastContactDate}` : null,
        facts.estimateDate ? `Estimate given: ${facts.estimateDate}` : null,
      ].filter(Boolean);
      const note = [
        `Re-engagement follow-up for ${[facts.firstName, facts.lastName].filter(Boolean).join(" ") || "this lead"}.`,
        knownBits.length > 0 ? knownBits.join(" · ") : "Limited record — verify details on first contact.",
        opts.objective?.trim() ? `Objective: ${opts.objective.trim()}` : "Objective: reopen the conversation and confirm current status.",
        "Reminder: use only facts on record; confirm anything uncertain with the contact directly.",
      ].join("\n");
      return parseMessageContent("follow_up_note", { note });
    }
    case "sequence": {
      const steps: Array<Record<string, unknown>> = [];
      const canEmail = !!facts.emailNormalized;
      const canSms = !!facts.phoneNormalized;
      if (canEmail) {
        steps.push({
          channel: "email",
          delayDays: 0,
          subject: facts.projectType?.trim() ? `Checking in on your ${facts.projectType.trim().toLowerCase()} project` : "Checking in on your project",
          body: `Hi ${name},\n\n${followLine} We'd love to know where things stand — reply any time.\n\n— ${opts.orgName}${opts.includeOptOutLanguage ? `\n\n${EMAIL_OPT_OUT}` : ""}`,
        });
      }
      if (canSms) {
        steps.push({
          channel: "sms",
          delayDays: steps.length === 0 ? 0 : 3,
          subject: null,
          body: `Hi ${name}, ${opts.orgName} here — just following up on ${project}. Still interested?${opts.includeOptOutLanguage ? ` ${SMS_OPT_OUT}` : ""}`,
        });
      }
      steps.push({
        channel: "call",
        delayDays: steps.length === 0 ? 0 : 7,
        subject: null,
        body: `Call ${facts.firstName?.trim() || "the contact"} to check in on ${project}. Open with the prior conversation, ask where things landed, and log the outcome.`,
      });
      if (canEmail) {
        steps.push({
          channel: "email",
          delayDays: 14,
          subject: "Should we close your file?",
          body: `Hi ${name},\n\nWe haven't heard back, so we'll assume the timing isn't right and quiet down. If ${project} is still on your list, one quick reply reopens it.\n\n— ${opts.orgName}${opts.includeOptOutLanguage ? `\n\n${EMAIL_OPT_OUT}` : ""}`,
        });
      }
      return parseMessageContent("sequence", { steps: steps.slice(0, 6) });
    }
  }
}
