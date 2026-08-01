import "server-only";
import { randomBytes } from "node:crypto";
import { getPool } from "../db";
import { intakeLead, parseLeadIntake, normalizeEmail, normalizePhone } from "../public-api/lead-intake";
import { suppressLeadContact, setLeadStage, logActivity } from "../rescue-engage/store";
import { emitOrgEventInBackground } from "./outgoing";
import { recordSyncConflict } from "../crm/store";
import { checkActionCapacity, recordUsageInBackground } from "../usage";

/**
 * Incoming webhooks: org-specific signed endpoints. Events are stored first
 * (unique per endpoint + event id → idempotent), then processed. Supported
 * events: lead.created, lead.updated, contact.opted_out, job.won, ping.
 */

export const INCOMING_EVENT_TYPES = ["lead.created", "lead.updated", "contact.opted_out", "job.won", "ping"] as const;
export type IncomingEventType = (typeof INCOMING_EVENT_TYPES)[number];

export function isIncomingEventType(value: string): value is IncomingEventType {
  return (INCOMING_EVENT_TYPES as readonly string[]).includes(value);
}

export type IncomingEndpoint = {
  id: string;
  organizationId: string;
  name: string;
  token: string;
  secret: string;
  status: "active" | "disabled";
  lastEventAt: string | null;
  createdAt: string;
};

const ENDPOINT_COLUMNS = `id, organization_id, name, token, secret, status, last_event_at, created_at`;

function mapEndpoint(row: Record<string, unknown>): IncomingEndpoint {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    name: String(row.name),
    token: String(row.token),
    secret: String(row.secret),
    status: row.status === "disabled" ? "disabled" : "active",
    lastEventAt: row.last_event_at ? new Date(row.last_event_at as string).toISOString() : null,
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

export async function createIncomingEndpoint(
  organizationId: string,
  input: { name: string; createdBy?: string | null },
): Promise<IncomingEndpoint> {
  const token = `iwh_${randomBytes(18).toString("base64url")}`;
  const secret = `ihsec_${randomBytes(24).toString("base64url")}`;
  const { rows } = await getPool().query(
    `INSERT INTO incoming_webhook_endpoints (organization_id, name, token, secret, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${ENDPOINT_COLUMNS}`,
    [organizationId, input.name, token, secret, input.createdBy ?? null],
  );
  return mapEndpoint(rows[0]);
}

export async function listIncomingEndpoints(organizationId: string): Promise<IncomingEndpoint[]> {
  const { rows } = await getPool().query(
    `SELECT ${ENDPOINT_COLUMNS} FROM incoming_webhook_endpoints WHERE organization_id = $1 ORDER BY created_at DESC`,
    [organizationId],
  );
  return rows.map(mapEndpoint);
}

export async function getIncomingEndpointByToken(token: string): Promise<IncomingEndpoint | null> {
  const { rows } = await getPool().query(`SELECT ${ENDPOINT_COLUMNS} FROM incoming_webhook_endpoints WHERE token = $1`, [token]);
  return rows[0] ? mapEndpoint(rows[0]) : null;
}

export async function setIncomingEndpointStatus(organizationId: string, endpointId: string, status: "active" | "disabled") {
  const { rows } = await getPool().query(
    `UPDATE incoming_webhook_endpoints SET status = $3 WHERE organization_id = $1 AND id = $2 RETURNING ${ENDPOINT_COLUMNS}`,
    [organizationId, endpointId, status],
  );
  return rows[0] ? mapEndpoint(rows[0]) : null;
}

export async function deleteIncomingEndpoint(organizationId: string, endpointId: string): Promise<boolean> {
  const result = await getPool().query(`DELETE FROM incoming_webhook_endpoints WHERE organization_id = $1 AND id = $2`, [
    organizationId,
    endpointId,
  ]);
  return (result.rowCount ?? 0) > 0;
}

export type IncomingEventRecord = {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  status: "received" | "processed" | "skipped" | "failed";
  result: string | null;
  error: string | null;
  processedAt: string | null;
  createdAt: string;
};

export async function listIncomingEvents(
  organizationId: string,
  options: { endpointId?: string; limit?: number } = {},
): Promise<IncomingEventRecord[]> {
  const limit = Math.min(options.limit ?? 50, 200);
  const params: unknown[] = [organizationId];
  let where = "organization_id = $1";
  if (options.endpointId) {
    params.push(options.endpointId);
    where += ` AND endpoint_id = $${params.length}`;
  }
  params.push(limit);
  const { rows } = await getPool().query(
    `SELECT id, endpoint_id, event_id, event_type, status, result, error, processed_at, created_at
     FROM incoming_webhook_events WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map((row) => ({
    id: String(row.id),
    endpointId: String(row.endpoint_id),
    eventId: String(row.event_id),
    eventType: String(row.event_type),
    status: String(row.status) as IncomingEventRecord["status"],
    result: row.result ? String(row.result) : null,
    error: row.error ? String(row.error) : null,
    processedAt: row.processed_at ? new Date(row.processed_at as string).toISOString() : null,
    createdAt: new Date(row.created_at as string).toISOString(),
  }));
}

async function findLeadByIdentifiers(organizationId: string, data: Record<string, unknown>) {
  const externalId = typeof data.externalRecordId === "string" ? data.externalRecordId : typeof data.external_record_id === "string" ? data.external_record_id : null;
  const email = normalizeEmail(typeof data.email === "string" ? data.email : null);
  const phone = normalizePhone(typeof data.phone === "string" ? data.phone : null);
  const conditions: string[] = [];
  const params: unknown[] = [organizationId];
  if (externalId) {
    params.push(externalId);
    conditions.push(`external_record_id = $${params.length}`);
  }
  if (email) {
    params.push(email);
    conditions.push(`email_normalized = $${params.length}`);
  }
  if (phone) {
    params.push(phone);
    conditions.push(`phone_normalized = $${params.length}`);
  }
  if (conditions.length === 0) return null;
  const { rows } = await getPool().query(
    `SELECT id, first_name, last_name, email, phone, project_type, project_description, estimated_value, notes, updated_at, suppressed
     FROM rescue_leads WHERE organization_id = $1 AND (${conditions.join(" OR ")}) ORDER BY updated_at DESC LIMIT 1`,
    params,
  );
  return rows[0] ?? null;
}

/** Fields a lead.updated event may change; used for conflict comparison too. */
const UPDATABLE_FIELDS: Array<{ key: string; column: string }> = [
  { key: "firstName", column: "first_name" },
  { key: "lastName", column: "last_name" },
  { key: "projectType", column: "project_type" },
  { key: "projectDescription", column: "project_description" },
  { key: "estimatedValue", column: "estimated_value" },
  { key: "notes", column: "notes" },
];

type ProcessOutcome = { status: "processed" | "skipped" | "failed"; result?: string; error?: string };

async function processEvent(endpoint: IncomingEndpoint, eventType: IncomingEventType, data: Record<string, unknown>): Promise<ProcessOutcome> {
  const organizationId = endpoint.organizationId;

  if (eventType === "ping") return { status: "processed", result: "pong" };

  if (eventType === "lead.created") {
    // Usage gate: creating leads is a gated action. (contact.opted_out below is
    // deliberately NEVER gated — opt-outs are always honored.)
    const capacity = await checkActionCapacity(organizationId, { leads_stored: 1, leads_imported: 1 });
    if (!capacity.allowed) return { status: "failed", error: capacity.reason ?? "Usage limit reached." };
    const parsed = parseLeadIntake(data);
    if (!parsed.input) return { status: "failed", error: parsed.message ?? "Invalid lead payload." };
    const result = await intakeLead(organizationId, { ...parsed.input, source: parsed.input.source === "api" ? "webhook" : parsed.input.source });
    if (result.outcome === "invalid") return { status: "failed", error: result.message };
    if (result.outcome === "duplicate") return { status: "skipped", result: `Duplicate of existing lead ${result.leadId}.` };
    await logActivity({
      organizationId,
      leadId: result.leadId,
      activityType: "webhook",
      title: "Lead received via incoming webhook",
      detail: `Endpoint: ${endpoint.name}`,
    });
    emitOrgEventInBackground(organizationId, "lead.created", { lead_id: result.leadId, source: "incoming_webhook" });
    recordUsageInBackground(organizationId, "leads_imported", 1);
    return { status: "processed", result: `Created lead ${result.leadId}${result.suppressed ? " (suppressed on arrival)" : ""}.` };
  }

  if (eventType === "lead.updated") {
    const lead = await findLeadByIdentifiers(organizationId, data);
    if (!lead) return { status: "skipped", result: "No matching lead found." };
    const remoteUpdatedAtRaw = data.updatedAt ?? data.updated_at;
    const remoteUpdatedAt = typeof remoteUpdatedAtRaw === "string" && !Number.isNaN(Date.parse(remoteUpdatedAtRaw)) ? new Date(remoteUpdatedAtRaw) : null;
    const localUpdatedAt = lead.updated_at ? new Date(lead.updated_at) : null;

    const changes: Array<{ field: string; column: string; localValue: unknown; remoteValue: unknown }> = [];
    for (const { key, column } of UPDATABLE_FIELDS) {
      if (data[key] === undefined) continue;
      const remoteValue = data[key];
      const localValue = lead[column];
      if (String(localValue ?? "") === String(remoteValue ?? "")) continue;
      changes.push({ field: key, column, localValue, remoteValue });
    }
    if (changes.length === 0) return { status: "skipped", result: "No field changes." };

    // Conflict rule: never silently overwrite newer local data. Without a remote
    // timestamp we cannot prove the remote copy is newer, so it also conflicts
    // whenever the local record has meaningful values in the changed fields.
    const remoteIsProvablyNewer = remoteUpdatedAt && localUpdatedAt && remoteUpdatedAt.getTime() > localUpdatedAt.getTime();
    const localHasValues = changes.some((c) => c.localValue !== null && c.localValue !== "");
    if (!remoteIsProvablyNewer && localHasValues) {
      const conflictId = await recordSyncConflict(organizationId, {
        leadId: String(lead.id),
        source: `incoming_webhook:${endpoint.name}`,
        fields: changes.map((c) => ({ field: c.field, localValue: c.localValue, remoteValue: c.remoteValue })),
        localUpdatedAt: localUpdatedAt?.toISOString() ?? null,
        remoteUpdatedAt: remoteUpdatedAt?.toISOString() ?? null,
      });
      return { status: "skipped", result: `Conflict recorded for manual review (${conflictId}) — local data may be newer.` };
    }

    const sets = changes.map((c, i) => `${c.column} = $${i + 3}`);
    await getPool().query(
      `UPDATE rescue_leads SET ${sets.join(", ")}, updated_at = now() WHERE organization_id = $1 AND id = $2`,
      [organizationId, lead.id, ...changes.map((c) => c.remoteValue)],
    );
    emitOrgEventInBackground(organizationId, "lead.updated", { lead_id: String(lead.id), source: "incoming_webhook", fields: changes.map((c) => c.field) });
    return { status: "processed", result: `Updated lead ${lead.id} (${changes.map((c) => c.field).join(", ")}).` };
  }

  if (eventType === "contact.opted_out") {
    const email = normalizeEmail(typeof data.email === "string" ? data.email : null);
    const phone = normalizePhone(typeof data.phone === "string" ? data.phone : null);
    if (!email && !phone) return { status: "failed", error: "contact.opted_out requires an email or phone." };
    const lead = await findLeadByIdentifiers(organizationId, data);
    if (lead) {
      await suppressLeadContact(organizationId, String(lead.id), "Opt-out received via incoming webhook", { optOut: true });
      emitOrgEventInBackground(organizationId, "lead.opted_out", { lead_id: String(lead.id), source: "incoming_webhook" });
    }
    // Defense in depth: suppression records protect future imports even without a lead.
    const pool = getPool();
    if (email) {
      await pool.query(
        `INSERT INTO suppression_records (organization_id, channel, value, reason, source) VALUES ($1, 'email', $2, 'opt_out', 'incoming_webhook')
         ON CONFLICT (organization_id, channel, value) DO NOTHING`,
        [organizationId, email],
      );
    }
    if (phone) {
      await pool.query(
        `INSERT INTO suppression_records (organization_id, channel, value, reason, source) VALUES ($1, 'phone', $2, 'opt_out', 'incoming_webhook')
         ON CONFLICT (organization_id, channel, value) DO NOTHING`,
        [organizationId, phone],
      );
    }
    return { status: "processed", result: lead ? `Suppressed lead ${lead.id} and recorded opt-out.` : "Recorded opt-out suppression (no matching lead)." };
  }

  if (eventType === "job.won") {
    const lead = await findLeadByIdentifiers(organizationId, data);
    if (!lead) return { status: "skipped", result: "No matching lead found." };
    if (lead.suppressed) return { status: "skipped", result: "Lead is suppressed; stage not changed." };
    const rawValue = data.wonValue ?? data.won_value ?? data.value;
    const wonValue = rawValue !== undefined && rawValue !== null && Number.isFinite(Number(rawValue)) ? Number(rawValue) : null;
    const moved = await setLeadStage(organizationId, String(lead.id), "won", { wonValue });
    if (!moved) return { status: "skipped", result: "Lead stage could not be changed." };
    await logActivity({
      organizationId,
      leadId: String(lead.id),
      activityType: "webhook",
      title: "Job marked won via incoming webhook",
      detail: wonValue ? `Won value: $${wonValue}` : null,
    });
    emitOrgEventInBackground(organizationId, "lead.updated", { lead_id: String(lead.id), source: "incoming_webhook", fields: ["pipeline_stage"] });
    return { status: "processed", result: `Lead ${lead.id} marked won.` };
  }

  return { status: "failed", error: `Unsupported event type: ${eventType}` };
}

export type IngestResult =
  | { accepted: true; duplicate: boolean; eventStatus: string; result?: string | null; error?: string | null }
  | { accepted: false; code: string; message: string };

/**
 * Stores + processes a verified incoming event. Idempotent on (endpoint, event id):
 * a replayed event id returns the original outcome without reprocessing.
 */
export async function ingestIncomingEvent(
  endpoint: IncomingEndpoint,
  event: { id: string; type: string; data: Record<string, unknown> },
): Promise<IngestResult> {
  if (!isIncomingEventType(event.type)) {
    return { accepted: false, code: "unsupported_event_type", message: `Unsupported event type: ${event.type}. Supported: ${INCOMING_EVENT_TYPES.join(", ")}` };
  }
  const pool = getPool();
  const inserted = await pool.query(
    `INSERT INTO incoming_webhook_events (endpoint_id, organization_id, event_id, event_type, payload)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (endpoint_id, event_id) DO NOTHING RETURNING id`,
    [endpoint.id, endpoint.organizationId, event.id, event.type, JSON.stringify(event.data ?? {})],
  );
  if (!inserted.rows[0]) {
    const { rows } = await pool.query(
      `SELECT status, result, error FROM incoming_webhook_events WHERE endpoint_id = $1 AND event_id = $2`,
      [endpoint.id, event.id],
    );
    return { accepted: true, duplicate: true, eventStatus: String(rows[0]?.status ?? "received"), result: rows[0]?.result ?? null, error: rows[0]?.error ?? null };
  }
  const rowId = String(inserted.rows[0].id);
  await pool.query(`UPDATE incoming_webhook_endpoints SET last_event_at = now() WHERE id = $1`, [endpoint.id]);
  recordUsageInBackground(endpoint.organizationId, "webhook_events", 1);

  let outcome: ProcessOutcome;
  try {
    outcome = await processEvent(endpoint, event.type, event.data ?? {});
  } catch (error) {
    console.error("Incoming webhook processing failed", error);
    outcome = { status: "failed", error: error instanceof Error ? error.message.slice(0, 500) : "Processing failed." };
  }
  await pool.query(
    `UPDATE incoming_webhook_events SET status = $2, result = $3, error = $4, processed_at = now() WHERE id = $1`,
    [rowId, outcome.status, outcome.result ?? null, outcome.error ?? null],
  );
  return { accepted: true, duplicate: false, eventStatus: outcome.status, result: outcome.result ?? null, error: outcome.error ?? null };
}
