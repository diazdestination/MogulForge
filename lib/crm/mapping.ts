/**
 * CRM field mapping with transforms. Pure functions — unit-testable and shared
 * by the mapping UI (preview) and the sync engine.
 */

export const LEAD_FIELDS = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "address",
  "city",
  "state",
  "zip",
  "projectType",
  "projectDescription",
  "estimatedValue",
  "source",
  "sourceDetail",
  "externalRecordId",
  "pipelineStage",
  "score",
  "notes",
] as const;
export type LeadField = (typeof LEAD_FIELDS)[number];

export function isLeadField(value: string): value is LeadField {
  return (LEAD_FIELDS as readonly string[]).includes(value);
}

export const MAPPING_TRANSFORMS = [
  "none",
  "trim",
  "uppercase",
  "lowercase",
  "titlecase",
  "digits_only",
  "e164_us",
  "full_name",
  "number",
] as const;
export type MappingTransform = (typeof MAPPING_TRANSFORMS)[number];

export const TRANSFORM_LABELS: Record<MappingTransform, string> = {
  none: "As-is",
  trim: "Trim whitespace",
  uppercase: "UPPERCASE",
  lowercase: "lowercase",
  titlecase: "Title Case",
  digits_only: "Digits only",
  e164_us: "US phone (+1XXXXXXXXXX)",
  full_name: "Combine first + last name",
  number: "Number",
};

export function isMappingTransform(value: string): value is MappingTransform {
  return (MAPPING_TRANSFORMS as readonly string[]).includes(value);
}

export type FieldMappingEntry = {
  /** Revenue Rescue lead field. */
  source: LeadField;
  /** Field name in the external system's payload. */
  target: string;
  transform: MappingTransform;
};

export function applyTransform(transform: MappingTransform, value: unknown, lead?: Record<string, unknown>): unknown {
  if (transform === "full_name") {
    const first = String(lead?.firstName ?? "").trim();
    const last = String(lead?.lastName ?? "").trim();
    return [first, last].filter(Boolean).join(" ") || null;
  }
  if (value === null || value === undefined) return null;
  const str = String(value);
  switch (transform) {
    case "none":
      return value;
    case "trim":
      return str.trim();
    case "uppercase":
      return str.toUpperCase();
    case "lowercase":
      return str.toLowerCase();
    case "titlecase":
      return str.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
    case "digits_only":
      return str.replace(/\D/g, "");
    case "e164_us": {
      const digits = str.replace(/\D/g, "");
      if (digits.length === 10) return `+1${digits}`;
      if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
      return digits ? `+${digits}` : null;
    }
    case "number": {
      const num = Number(str);
      return Number.isFinite(num) ? num : null;
    }
    default:
      return value;
  }
}

/** Validates a raw mapping array from the client. Returns errors instead of throwing. */
export function validateFieldMapping(raw: unknown): { mapping: FieldMappingEntry[]; errors: string[] } {
  const errors: string[] = [];
  const mapping: FieldMappingEntry[] = [];
  if (!Array.isArray(raw)) return { mapping, errors: ["Field mapping must be an array."] };
  const seenTargets = new Set<string>();
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") {
      errors.push(`Row ${index + 1}: not an object.`);
      return;
    }
    const { source, target, transform } = entry as Record<string, unknown>;
    if (typeof source !== "string" || !isLeadField(source)) {
      errors.push(`Row ${index + 1}: unknown lead field "${String(source)}".`);
      return;
    }
    if (typeof target !== "string" || !target.trim()) {
      errors.push(`Row ${index + 1}: target field name is required.`);
      return;
    }
    const cleanTarget = target.trim().slice(0, 100);
    if (seenTargets.has(cleanTarget)) {
      errors.push(`Row ${index + 1}: duplicate target field "${cleanTarget}".`);
      return;
    }
    seenTargets.add(cleanTarget);
    const cleanTransform = typeof transform === "string" && isMappingTransform(transform) ? transform : "none";
    mapping.push({ source, target: cleanTarget, transform: cleanTransform });
  });
  return { mapping, errors };
}

/** Maps a Revenue Rescue lead object to the external payload shape. */
export function applyFieldMapping(mapping: FieldMappingEntry[], lead: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const entry of mapping) {
    output[entry.target] = applyTransform(entry.transform, lead[entry.source], lead);
  }
  return output;
}

/** A realistic sample lead for mapping previews and connection tests. */
export const SAMPLE_LEAD: Record<string, unknown> = {
  firstName: "Jordan",
  lastName: "Rivera",
  email: "jordan.rivera@example.com",
  phone: "(555) 201-7788",
  address: "412 Maple Street",
  city: "Springfield",
  state: "OH",
  zip: "45501",
  projectType: "Roof replacement",
  projectDescription: "Hail damage across the south-facing slope; insurance claim open.",
  estimatedValue: 14500,
  source: "sample",
  sourceDetail: "Field-mapping test",
  externalRecordId: "SAMPLE-001",
  pipelineStage: "analyzed",
  score: 82,
  notes: "Prefers afternoon calls.",
};
