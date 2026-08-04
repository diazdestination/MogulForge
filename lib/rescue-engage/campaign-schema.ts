/** Campaign types + input validation from the Revenue Rescue spec. Pure module. */
import { isLeadCategory, type LeadCategory } from "../rescue-analysis/categories.ts";

export const CAMPAIGN_CHANNELS = ["sms", "email"] as const;
export type CampaignChannel = (typeof CAMPAIGN_CHANNELS)[number];

export const CAMPAIGN_TONES = ["professional", "friendly", "urgent"] as const;
export type CampaignTone = (typeof CAMPAIGN_TONES)[number];

export const APPROVAL_MODES = ["every_message", "campaign_templates", "automation_rules", "simulation_only"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export const APPROVAL_MODE_LABELS: Record<ApprovalMode, string> = {
  every_message: "Approve every message",
  campaign_templates: "Approve campaign templates",
  automation_rules: "Allow approved automation rules",
  simulation_only: "Simulation only",
};

export const CAMPAIGN_STATUSES = ["draft", "active", "paused", "completed", "archived"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const STOP_CONDITIONS = ["reply", "opt_out", "appointment_booked", "max_attempts"] as const;
export type StopCondition = (typeof STOP_CONDITIONS)[number];

export const STOP_CONDITION_LABELS: Record<StopCondition, string> = {
  reply: "Stop after any reply",
  opt_out: "Stop on opt-out (always enforced)",
  appointment_booked: "Stop once an appointment is booked",
  max_attempts: "Stop after the maximum attempts",
};

export type AudienceFilters = {
  categories: LeadCategory[];
  minScore: number | null;
  projectTypes: string[];
  sources: string[];
  importId: string | null;
};

/**
 * Quiet-hours check for a given local hour (0-23). Quiet hours wrap midnight
 * (e.g. start 20 / end 8 means no sends from 8pm through 7:59am). Equal
 * start/end means quiet hours are disabled.
 */
export function isWithinQuietHours(schedule: Pick<CampaignSchedule, "quietHoursStart" | "quietHoursEnd">, hour: number): boolean {
  const { quietHoursStart: start, quietHoursEnd: end } = schedule;
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export type CampaignSchedule = {
  startDate: string | null; // ISO date; null = start on activation
  quietHoursStart: number; // local hour 0-23 — no sends at/after this hour
  quietHoursEnd: number; // local hour 0-23 — no sends before this hour
};

export type CampaignInput = {
  name: string;
  templateKey: string | null;
  objective: string | null;
  channel: CampaignChannel;
  tone: CampaignTone;
  senderIdentity: string | null;
  audience: AudienceFilters;
  schedule: CampaignSchedule;
  approvalMode: ApprovalMode;
  followUpDelayDays: number;
  maxAttempts: number;
  stopConditions: StopCondition[];
  bookingLink: string | null;
  assignedUserId: string | null;
};

export class CampaignValidationError extends Error {}

function str(value: unknown, max = 300): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function strArray(value: unknown, max = 40): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim().slice(0, 120))
    .slice(0, max);
}

function intIn(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? Math.trunc(value) : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** Validates raw request bodies into a CampaignInput. Throws CampaignValidationError with a user-safe message. */
export function parseCampaignInput(body: Record<string, unknown>): CampaignInput {
  const name = str(body.name, 120);
  if (!name) throw new CampaignValidationError("Campaign name is required.");
  const channel = String(body.channel ?? "");
  if (!(CAMPAIGN_CHANNELS as readonly string[]).includes(channel)) {
    throw new CampaignValidationError("Channel must be sms or email.");
  }
  const tone = (CAMPAIGN_TONES as readonly string[]).includes(String(body.tone)) ? (body.tone as CampaignTone) : "professional";
  const approvalMode = (APPROVAL_MODES as readonly string[]).includes(String(body.approvalMode))
    ? (body.approvalMode as ApprovalMode)
    : "every_message";

  const rawAudience = (body.audience ?? {}) as Record<string, unknown>;
  const categories = strArray(rawAudience.categories).filter(isLeadCategory);
  const minScoreRaw = rawAudience.minScore;
  const minScore = minScoreRaw === null || minScoreRaw === undefined || minScoreRaw === "" ? null : intIn(minScoreRaw, 0, 100, 0);

  const rawSchedule = (body.schedule ?? {}) as Record<string, unknown>;
  const startDate = str(rawSchedule.startDate, 40);
  if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new CampaignValidationError("Schedule start date must be YYYY-MM-DD.");

  const stopConditions = strArray(body.stopConditions).filter((v): v is StopCondition =>
    (STOP_CONDITIONS as readonly string[]).includes(v),
  );
  // Opt-out stopping is not optional — always enforced.
  if (!stopConditions.includes("opt_out")) stopConditions.push("opt_out");

  return {
    name,
    templateKey: str(body.templateKey, 60),
    objective: str(body.objective, 500),
    channel: channel as CampaignChannel,
    tone,
    senderIdentity: str(body.senderIdentity, 120),
    audience: {
      categories,
      minScore,
      projectTypes: strArray(rawAudience.projectTypes),
      sources: strArray(rawAudience.sources),
      importId: str(rawAudience.importId, 60),
    },
    schedule: {
      startDate,
      quietHoursStart: intIn(rawSchedule.quietHoursStart, 0, 23, 20),
      quietHoursEnd: intIn(rawSchedule.quietHoursEnd, 0, 23, 8),
    },
    approvalMode,
    followUpDelayDays: intIn(body.followUpDelayDays, 0, 60, 3),
    maxAttempts: intIn(body.maxAttempts, 1, 10, 3),
    stopConditions,
    bookingLink: str(body.bookingLink, 300),
    assignedUserId: str(body.assignedUserId, 60),
  };
}
