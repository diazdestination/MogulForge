/** Import status metadata shared by server pages and client components. Pure module. */

export const IMPORT_STAGE_SEQUENCE = [
  "uploaded",
  "validating",
  "mapping_required",
  "cleaning",
  "deduplicating",
  "suppression_checking",
  "importing",
  "complete",
] as const;

export const IMPORT_STATUS_LABELS: Record<string, string> = {
  uploaded: "Uploaded",
  validating: "Validating",
  mapping_required: "Mapping required",
  cleaning: "Cleaning",
  deduplicating: "Deduplicating",
  suppression_checking: "Checking suppressions",
  importing: "Importing",
  analyzing: "Analyzing",
  complete: "Complete",
  failed: "Failed",
  partial: "Partial",
};

/** Statuses where the pipeline is actively running (dashboard should poll). */
export function isProcessingStatus(status: string): boolean {
  return ["validating", "cleaning", "deduplicating", "suppression_checking", "importing"].includes(status);
}

export function isTerminalStatus(status: string): boolean {
  return ["complete", "failed", "partial"].includes(status);
}

/** 0–100 progress for the stage rail on the imports dashboard. */
export function statusProgress(status: string): number {
  if (status === "failed" || status === "partial" || status === "complete") return 100;
  const idx = (IMPORT_STAGE_SEQUENCE as readonly string[]).indexOf(status);
  if (idx < 0) return 0;
  return Math.round((idx / (IMPORT_STAGE_SEQUENCE.length - 1)) * 100);
}
