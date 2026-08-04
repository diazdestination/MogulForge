import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { getPool } from "../db";
import { logAudit } from "../audit";
import { signWebhookPayload, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "./signature";

/**
 * Outgoing webhooks: per-endpoint signing secrets, delivery logs, exponential
 * backoff retries, manual retry, and test events. Deliveries are attempted
 * inline on emit; failures are retried by the background processor.
 */

export const OUTGOING_EVENT_TYPES = [
  "lead.created",
  "lead.updated",
  "lead.opted_out",
  "campaign.status_changed",
  "appointment.created",
  "appointment.updated",
  "test.ping",
] as const;
export type OutgoingEventType = (typeof OUTGOING_EVENT_TYPES)[number];

export function isOutgoingEventType(value: string): value is OutgoingEventType {
  return (OUTGOING_EVENT_TYPES as readonly string[]).includes(value);
}

/** Backoff schedule (seconds) after attempt N fails: 1m, 5m, 30m, 2h, 8h; then exhausted. */
export const RETRY_BACKOFF_SECONDS = [60, 300, 1800, 7200, 28800];
export const MAX_ATTEMPTS = RETRY_BACKOFF_SECONDS.length + 1;
const DELIVERY_TIMEOUT_MS = 10_000;
/** Endpoints are auto-disabled after this many consecutive failures. */
const AUTO_DISABLE_FAILURES = 20;

export type OutgoingEndpoint = {
  id: string;
  organizationId: string;
  url: string;
  description: string | null;
  secret: string;
  eventTypes: OutgoingEventType[];
  status: "active" | "disabled";
  failureCount: number;
  createdAt: string;
};

export type DeliveryRecord = {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  payload: unknown;
  status: "pending" | "succeeded" | "failed" | "exhausted" | "disabled";
  attempts: number;
  nextAttemptAt: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
};

const ENDPOINT_COLUMNS = `id, organization_id, url, description, secret, event_types, status, failure_count, created_at`;

function mapEndpoint(row: Record<string, unknown>): OutgoingEndpoint {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    url: String(row.url),
    description: row.description ? String(row.description) : null,
    secret: String(row.secret),
    eventTypes: ((row.event_types as string[]) ?? []).filter(isOutgoingEventType),
    status: row.status === "disabled" ? "disabled" : "active",
    failureCount: Number(row.failure_count ?? 0),
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

function mapDelivery(row: Record<string, unknown>): DeliveryRecord {
  return {
    id: String(row.id),
    endpointId: String(row.endpoint_id),
    eventId: String(row.event_id),
    eventType: String(row.event_type),
    payload: row.payload,
    status: String(row.status) as DeliveryRecord["status"],
    attempts: Number(row.attempts ?? 0),
    nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at as string).toISOString() : null,
    lastStatusCode: row.last_status_code == null ? null : Number(row.last_status_code),
    lastError: row.last_error ? String(row.last_error) : null,
    deliveredAt: row.delivered_at ? new Date(row.delivered_at as string).toISOString() : null,
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

export function validateWebhookUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "Webhook URLs must use http or https.";
    return null;
  } catch {
    return "Webhook URL is not a valid URL.";
  }
}

export async function createOutgoingEndpoint(
  organizationId: string,
  input: { url: string; description?: string | null; eventTypes: OutgoingEventType[]; createdBy?: string | null },
): Promise<OutgoingEndpoint> {
  const secret = `whsec_${randomBytes(24).toString("base64url")}`;
  const { rows } = await getPool().query(
    `INSERT INTO outgoing_webhook_endpoints (organization_id, url, description, secret, event_types, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${ENDPOINT_COLUMNS}`,
    [organizationId, input.url, input.description ?? null, secret, input.eventTypes, input.createdBy ?? null],
  );
  return mapEndpoint(rows[0]);
}

export async function listOutgoingEndpoints(organizationId: string): Promise<OutgoingEndpoint[]> {
  const { rows } = await getPool().query(
    `SELECT ${ENDPOINT_COLUMNS} FROM outgoing_webhook_endpoints WHERE organization_id = $1 ORDER BY created_at DESC`,
    [organizationId],
  );
  return rows.map(mapEndpoint);
}

export async function getOutgoingEndpoint(organizationId: string, endpointId: string): Promise<OutgoingEndpoint | null> {
  const { rows } = await getPool().query(
    `SELECT ${ENDPOINT_COLUMNS} FROM outgoing_webhook_endpoints WHERE organization_id = $1 AND id = $2`,
    [organizationId, endpointId],
  );
  return rows[0] ? mapEndpoint(rows[0]) : null;
}

export async function updateOutgoingEndpoint(
  organizationId: string,
  endpointId: string,
  patch: { url?: string; description?: string | null; eventTypes?: OutgoingEventType[]; status?: "active" | "disabled" },
): Promise<OutgoingEndpoint | null> {
  const sets: string[] = [];
  const params: unknown[] = [organizationId, endpointId];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    sets.push(`${sql} = $${params.length}`);
  };
  if (patch.url !== undefined) add("url", patch.url);
  if (patch.description !== undefined) add("description", patch.description);
  if (patch.eventTypes !== undefined) add("event_types", patch.eventTypes);
  if (patch.status !== undefined) {
    add("status", patch.status);
    if (patch.status === "active") sets.push("failure_count = 0");
  }
  if (sets.length === 0) return getOutgoingEndpoint(organizationId, endpointId);
  const { rows } = await getPool().query(
    `UPDATE outgoing_webhook_endpoints SET ${sets.join(", ")} WHERE organization_id = $1 AND id = $2 RETURNING ${ENDPOINT_COLUMNS}`,
    params,
  );
  return rows[0] ? mapEndpoint(rows[0]) : null;
}

export async function deleteOutgoingEndpoint(organizationId: string, endpointId: string): Promise<boolean> {
  const result = await getPool().query(`DELETE FROM outgoing_webhook_endpoints WHERE organization_id = $1 AND id = $2`, [
    organizationId,
    endpointId,
  ]);
  return (result.rowCount ?? 0) > 0;
}

export async function listDeliveries(
  organizationId: string,
  options: { endpointId?: string; limit?: number } = {},
): Promise<DeliveryRecord[]> {
  const limit = Math.min(options.limit ?? 50, 200);
  const params: unknown[] = [organizationId];
  let where = "organization_id = $1";
  if (options.endpointId) {
    params.push(options.endpointId);
    where += ` AND endpoint_id = $${params.length}`;
  }
  params.push(limit);
  const { rows } = await getPool().query(
    `SELECT * FROM outgoing_webhook_deliveries WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map(mapDelivery);
}

/** Attempts one delivery over HTTP with signing headers. Returns updated record. */
async function attemptDelivery(endpoint: OutgoingEndpoint, deliveryId: string, eventEnvelope: unknown): Promise<void> {
  const pool = getPool();
  const rawBody = JSON.stringify(eventEnvelope);
  const timestamp = Math.floor(Date.now() / 1000);
  let statusCode: number | null = null;
  let errorMessage: string | null = null;
  try {
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "RevenueRescue-Webhooks/1.0",
        [TIMESTAMP_HEADER]: String(timestamp),
        [SIGNATURE_HEADER]: signWebhookPayload(endpoint.secret, timestamp, rawBody),
      },
      body: rawBody,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      redirect: "error",
    });
    statusCode = response.status;
    if (!response.ok) errorMessage = `Receiver responded with HTTP ${response.status}.`;
  } catch (error) {
    errorMessage = error instanceof Error ? error.message.slice(0, 500) : "Delivery failed.";
  }

  if (!errorMessage) {
    await pool.query(
      `UPDATE outgoing_webhook_deliveries
       SET status = 'succeeded', attempts = attempts + 1, last_status_code = $2, last_error = NULL, next_attempt_at = NULL, delivered_at = now()
       WHERE id = $1`,
      [deliveryId, statusCode],
    );
    await pool.query(`UPDATE outgoing_webhook_endpoints SET failure_count = 0 WHERE id = $1`, [endpoint.id]);
    return;
  }

  const { rows } = await pool.query(
    `UPDATE outgoing_webhook_deliveries
     SET attempts = attempts + 1, last_status_code = $2, last_error = $3
     WHERE id = $1 RETURNING attempts`,
    [deliveryId, statusCode, errorMessage],
  );
  const attempts = Number(rows[0]?.attempts ?? 1);
  const exhausted = attempts >= MAX_ATTEMPTS;
  const backoff = RETRY_BACKOFF_SECONDS[Math.min(attempts - 1, RETRY_BACKOFF_SECONDS.length - 1)];
  await pool.query(
    `UPDATE outgoing_webhook_deliveries SET status = $2, next_attempt_at = $3 WHERE id = $1`,
    [deliveryId, exhausted ? "exhausted" : "failed", exhausted ? null : new Date(Date.now() + backoff * 1000)],
  );
  const failureResult = await pool.query(
    `UPDATE outgoing_webhook_endpoints SET failure_count = failure_count + 1 WHERE id = $1 RETURNING failure_count`,
    [endpoint.id],
  );
  if (Number(failureResult.rows[0]?.failure_count ?? 0) >= AUTO_DISABLE_FAILURES) {
    await pool.query(`UPDATE outgoing_webhook_endpoints SET status = 'disabled' WHERE id = $1`, [endpoint.id]);
    await logAudit({
      organizationId: endpoint.organizationId,
      actorLabel: "system",
      action: "webhook_endpoint.auto_disabled",
      targetType: "webhook_endpoint",
      targetId: endpoint.id,
      metadata: { url: endpoint.url },
    });
  }
}

function buildEnvelope(eventId: string, eventType: string, data: unknown) {
  return { id: eventId, type: eventType, created_at: new Date().toISOString(), data };
}

/**
 * Emits an event to every active endpoint subscribed to its type. Delivery rows
 * are always recorded first, then attempted inline (fire-and-forget safe).
 */
export async function emitOrgEvent(
  organizationId: string,
  eventType: OutgoingEventType,
  data: unknown,
): Promise<{ deliveries: number }> {
  const endpoints = (await listOutgoingEndpoints(organizationId)).filter(
    (e) => e.status === "active" && e.eventTypes.includes(eventType),
  );
  if (endpoints.length === 0) return { deliveries: 0 };
  const eventId = `evt_${randomUUID()}`;
  const envelope = buildEnvelope(eventId, eventType, data);
  const pool = getPool();
  await Promise.all(
    endpoints.map(async (endpoint) => {
      const { rows } = await pool.query(
        `INSERT INTO outgoing_webhook_deliveries (endpoint_id, organization_id, event_id, event_type, payload)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [endpoint.id, organizationId, eventId, eventType, JSON.stringify(envelope)],
      );
      await attemptDelivery(endpoint, String(rows[0].id), envelope).catch((error) =>
        console.error("Webhook delivery attempt failed", error),
      );
    }),
  );
  return { deliveries: endpoints.length };
}

/** Fire-and-forget emit for use inside request handlers. Never throws. */
export function emitOrgEventInBackground(organizationId: string, eventType: OutgoingEventType, data: unknown) {
  emitOrgEvent(organizationId, eventType, data).catch((error) => console.error("Webhook emit failed", error));
}

/** Sends a test.ping event to a single endpoint (even when disabled) and returns the delivery. */
export async function sendTestEvent(organizationId: string, endpointId: string): Promise<DeliveryRecord | null> {
  const endpoint = await getOutgoingEndpoint(organizationId, endpointId);
  if (!endpoint) return null;
  const eventId = `evt_${randomUUID()}`;
  const envelope = buildEnvelope(eventId, "test.ping", { message: "Revenue Rescue webhook test event." });
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO outgoing_webhook_deliveries (endpoint_id, organization_id, event_id, event_type, payload)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [endpoint.id, organizationId, eventId, "test.ping", JSON.stringify(envelope)],
  );
  await attemptDelivery(endpoint, String(rows[0].id), envelope);
  const { rows: updated } = await pool.query(`SELECT * FROM outgoing_webhook_deliveries WHERE id = $1`, [rows[0].id]);
  return updated[0] ? mapDelivery(updated[0]) : null;
}

/** Manual retry: re-attempts a failed/exhausted delivery immediately. */
export async function retryDelivery(organizationId: string, deliveryId: string): Promise<DeliveryRecord | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT d.*, e.organization_id AS endpoint_org FROM outgoing_webhook_deliveries d
     JOIN outgoing_webhook_endpoints e ON e.id = d.endpoint_id
     WHERE d.organization_id = $1 AND d.id = $2`,
    [organizationId, deliveryId],
  );
  if (!rows[0]) return null;
  const endpoint = await getOutgoingEndpoint(organizationId, String(rows[0].endpoint_id));
  if (!endpoint) return null;
  await attemptDelivery(endpoint, deliveryId, rows[0].payload);
  const { rows: updated } = await pool.query(`SELECT * FROM outgoing_webhook_deliveries WHERE id = $1`, [deliveryId]);
  return updated[0] ? mapDelivery(updated[0]) : null;
}

/** Retention: succeeded delivery rows are pruned after this many days. */
export const DELIVERY_SUCCEEDED_RETENTION_DAYS = 30;
/** Retention: failed/exhausted/disabled rows are kept longer so retries and debugging stay possible. */
export const DELIVERY_FAILED_RETENTION_DAYS = 90;

/**
 * Deletes old outgoing webhook delivery rows per retention policy. Rows still
 * awaiting a retry (status 'failed' with a future next_attempt_at) are far
 * younger than the retention window, so cutting on created_at is safe.
 */
export async function cleanupOldWebhookDeliveries(): Promise<{ succeededDeleted: number; failedDeleted: number }> {
  const pool = getPool();
  const succeeded = await pool.query(
    `DELETE FROM outgoing_webhook_deliveries
     WHERE status = 'succeeded' AND created_at < now() - make_interval(days => $1)`,
    [DELIVERY_SUCCEEDED_RETENTION_DAYS],
  );
  const failed = await pool.query(
    `DELETE FROM outgoing_webhook_deliveries
     WHERE status IN ('failed', 'exhausted', 'disabled', 'pending') AND created_at < now() - make_interval(days => $1)`,
    [DELIVERY_FAILED_RETENTION_DAYS],
  );
  return { succeededDeleted: succeeded.rowCount ?? 0, failedDeleted: failed.rowCount ?? 0 };
}

/** Background processor: retries all due failed deliveries. Called from instrumentation + cron. */
export async function processDueDeliveries(limit = 25): Promise<{ processed: number }> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT d.id, d.payload, d.endpoint_id, d.organization_id FROM outgoing_webhook_deliveries d
     JOIN outgoing_webhook_endpoints e ON e.id = d.endpoint_id
     WHERE d.status = 'failed' AND d.next_attempt_at IS NOT NULL AND d.next_attempt_at <= now() AND e.status = 'active'
     ORDER BY d.next_attempt_at ASC LIMIT $1`,
    [limit],
  );
  for (const row of rows) {
    const endpoint = await getOutgoingEndpoint(String(row.organization_id), String(row.endpoint_id));
    if (!endpoint || endpoint.status !== "active") continue;
    await attemptDelivery(endpoint, String(row.id), row.payload).catch((error) =>
      console.error("Webhook retry failed", error),
    );
  }
  return { processed: rows.length };
}
