/** Opportunity-funnel pipeline stages from the Revenue Rescue spec. Pure module. */

export const PIPELINE_STAGES = [
  "imported",
  "cleaned",
  "analyzed",
  "approved",
  "contacted",
  "replied",
  "qualified",
  "appointment_booked",
  "estimate_issued",
  "won",
  "lost",
  "suppressed",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const STAGE_LABELS: Record<PipelineStage, string> = {
  imported: "Imported",
  cleaned: "Cleaned",
  analyzed: "Analyzed",
  approved: "Approved",
  contacted: "Contacted",
  replied: "Replied",
  qualified: "Qualified",
  appointment_booked: "Appointment booked",
  estimate_issued: "Estimate issued",
  won: "Won",
  lost: "Lost",
  suppressed: "Suppressed",
};

export function isPipelineStage(value: string): value is PipelineStage {
  return (PIPELINE_STAGES as readonly string[]).includes(value);
}

/** Stages a user may set directly from the lead actions menu (the rest are set by the system). */
export const MANUAL_STAGES: PipelineStage[] = [
  "approved",
  "contacted",
  "replied",
  "qualified",
  "appointment_booked",
  "estimate_issued",
  "won",
  "lost",
];

/** Stages counted as "recovered pipeline" (value in play after re-engagement). */
export const PIPELINE_VALUE_STAGES: PipelineStage[] = ["replied", "qualified", "appointment_booked", "estimate_issued"];
