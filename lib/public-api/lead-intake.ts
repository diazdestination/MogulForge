import "server-only";
import { getPool } from "../db";

/**
 * Direct single-lead intake used by the public API (POST /api/v1/leads) and by
 * incoming webhook events (lead.created). Applies the same normalization,
 * suppression, and duplicate checks the import pipeline uses — one lead at a time.
 */

export type LeadIntakeInput = {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  projectType?: string | null;
  projectDescription?: string | null;
  estimatedValue?: number | null;
  source?: string | null;
  sourceDetail?: string | null;
  externalRecordId?: string | null;
  consentStatus?: "unknown" | "express" | "implied";
  notes?: string | null;
};

export type LeadIntakeResult =
  | { outcome: "created"; leadId: string; suppressed: boolean }
  | { outcome: "duplicate"; leadId: string }
  | { outcome: "invalid"; message: string };

export function normalizeEmail(email: string | null | undefined) {
  const value = (email ?? "").trim().toLowerCase();
  return value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
}

export function normalizePhone(phone: string | null | undefined) {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits : null;
}

const text = (value: unknown, max = 500) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
};

/** Validates + coerces an untyped payload (API body or webhook event data). */
export function parseLeadIntake(data: Record<string, unknown>): { input: LeadIntakeInput | null; message?: string } {
  const input: LeadIntakeInput = {
    firstName: text(data.firstName ?? data.first_name),
    lastName: text(data.lastName ?? data.last_name),
    email: text(data.email),
    phone: text(data.phone, 50),
    address: text(data.address),
    city: text(data.city),
    state: text(data.state, 100),
    zip: text(data.zip ?? data.postalCode ?? data.postal_code, 20),
    projectType: text(data.projectType ?? data.project_type),
    projectDescription: text(data.projectDescription ?? data.project_description, 4000),
    source: text(data.source) ?? "api",
    sourceDetail: text(data.sourceDetail ?? data.source_detail),
    externalRecordId: text(data.externalRecordId ?? data.external_record_id, 255),
    notes: text(data.notes, 4000),
  };
  const rawValue = data.estimatedValue ?? data.estimated_value;
  if (rawValue !== undefined && rawValue !== null && rawValue !== "") {
    const num = Number(rawValue);
    if (!Number.isFinite(num) || num < 0 || num > 99_999_999) return { input: null, message: "estimatedValue must be a non-negative number." };
    input.estimatedValue = Math.round(num * 100) / 100;
  }
  const consent = data.consentStatus ?? data.consent_status;
  if (consent !== undefined && consent !== null) {
    if (consent !== "unknown" && consent !== "express" && consent !== "implied") {
      return { input: null, message: "consentStatus must be one of unknown, express, implied." };
    }
    input.consentStatus = consent;
  }
  if (!input.email && !input.phone) return { input: null, message: "A lead needs at least an email or a phone number." };
  return { input };
}

export async function intakeLead(organizationId: string, input: LeadIntakeInput): Promise<LeadIntakeResult> {
  const emailNormalized = normalizeEmail(input.email);
  const phoneNormalized = normalizePhone(input.phone);
  if (!emailNormalized && !phoneNormalized) {
    return { outcome: "invalid", message: "A lead needs a valid email or a phone number with at least 10 digits." };
  }
  const pool = getPool();

  // Duplicate check mirrors the import pipeline: match on external id, email, or phone.
  const dupConditions: string[] = [];
  const dupParams: unknown[] = [organizationId];
  if (input.externalRecordId) {
    dupParams.push(input.externalRecordId);
    dupConditions.push(`external_record_id = $${dupParams.length}`);
  }
  if (emailNormalized) {
    dupParams.push(emailNormalized);
    dupConditions.push(`email_normalized = $${dupParams.length}`);
  }
  if (phoneNormalized) {
    dupParams.push(phoneNormalized);
    dupConditions.push(`phone_normalized = $${dupParams.length}`);
  }
  const dup = await pool.query(
    `SELECT id FROM rescue_leads WHERE organization_id = $1 AND (${dupConditions.join(" OR ")}) LIMIT 1`,
    dupParams,
  );
  if (dup.rows[0]) return { outcome: "duplicate", leadId: String(dup.rows[0].id) };

  // Suppression check against the org's do-not-contact list.
  const suppressed = await pool.query(
    `SELECT reason FROM suppression_records
     WHERE organization_id = $1 AND ((channel = 'email' AND value = $2) OR (channel = 'phone' AND value = $3)) LIMIT 1`,
    [organizationId, emailNormalized ?? "", phoneNormalized ?? ""],
  );
  const suppressionReason = suppressed.rows[0] ? String(suppressed.rows[0].reason ?? "suppression list") : null;

  const { rows } = await pool.query(
    `INSERT INTO rescue_leads (
       organization_id, first_name, last_name, email, email_normalized, phone, phone_normalized,
       address, city, state, zip, project_type, project_description, estimated_value,
       source, source_detail, external_record_id, consent_status, notes,
       suppressed, suppression_reason, pipeline_stage, stage_changed_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22, now())
     RETURNING id`,
    [
      organizationId,
      input.firstName ?? null,
      input.lastName ?? null,
      input.email ?? null,
      emailNormalized,
      input.phone ?? null,
      phoneNormalized,
      input.address ?? null,
      input.city ?? null,
      input.state ?? null,
      input.zip ?? null,
      input.projectType ?? null,
      input.projectDescription ?? null,
      input.estimatedValue ?? null,
      input.source ?? "api",
      input.sourceDetail ?? null,
      input.externalRecordId ?? null,
      input.consentStatus ?? "unknown",
      input.notes ?? null,
      Boolean(suppressionReason),
      suppressionReason,
      suppressionReason ? "suppressed" : "imported",
    ],
  );
  return { outcome: "created", leadId: String(rows[0].id), suppressed: Boolean(suppressionReason) };
}
