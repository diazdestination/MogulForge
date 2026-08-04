import "server-only";
import { getPool } from "../db";
import { logAudit } from "../audit";
import { pushLeadForProvider } from "./adapters";
import { getCrmConnection } from "./store";

/**
 * Per-connection CRM push delivery log (mirrors the outgoing-webhook deliveries
 * pattern). Every outbound lead push — success or failure — is recorded so
 * clients can see exactly which leads reached their CRM and retry failures.
 * Repeated consecutive failures flip the connection status to 'error'.
 */

/** Consecutive push failures before a connection is flipped to 'error'. */
export const ERROR_THRESHOLD_FAILURES = 5;

export type CrmPushDelivery = {
  id: string;
  organizationId: string;
  connectionId: string;
  leadId: string;
  leadName: string | null;
  provider: string;
  status: "succeeded" | "failed";
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function mapRow(row: Record<string, unknown>): CrmPushDelivery {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    connectionId: String(row.connection_id),
    leadId: String(row.lead_id),
    leadName: [row.first_name, row.last_name].filter(Boolean).join(" ") || null,
    provider: String(row.provider),
    status: row.status === "succeeded" ? "succeeded" : "failed",
    attempts: Number(row.attempts ?? 1),
    lastStatusCode: row.last_status_code == null ? null : Number(row.last_status_code),
    lastError: row.last_error ? String(row.last_error) : null,
    deliveredAt: row.delivered_at ? new Date(row.delivered_at as string).toISOString() : null,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

const SELECT_WITH_LEAD = `SELECT d.*, l.first_name, l.last_name FROM crm_push_deliveries d
  LEFT JOIN rescue_leads l ON l.id = d.lead_id`;

/** Records one push outcome and updates the connection's consecutive-failure counter. */
export async function recordPushDelivery(
  organizationId: string,
  input: { connectionId: string; leadId: string; provider: string; ok: boolean; statusCode: number | null; message: string },
): Promise<string> {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO crm_push_deliveries (organization_id, connection_id, lead_id, provider, status, last_status_code, last_error, delivered_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      organizationId,
      input.connectionId,
      input.leadId,
      input.provider,
      input.ok ? "succeeded" : "failed",
      input.statusCode,
      input.ok ? null : input.message.slice(0, 500),
      input.ok ? new Date() : null,
    ],
  );
  await bumpFailureCount(organizationId, input.connectionId, input.provider, input.ok);
  return String(rows[0].id);
}

/** Resets the counter on success; on failure increments and flips the connection to 'error' at the threshold. */
async function bumpFailureCount(organizationId: string, connectionId: string, provider: string, ok: boolean): Promise<void> {
  const pool = getPool();
  if (ok) {
    // A success proves the connection works again — clear the counter and recover from 'error'.
    await pool.query(
      `UPDATE crm_connections SET push_failure_count = 0,
         status = CASE WHEN status = 'error' THEN 'active' ELSE status END, updated_at = now()
       WHERE organization_id = $1 AND id = $2`,
      [organizationId, connectionId],
    );
    return;
  }
  const { rows } = await pool.query(
    `UPDATE crm_connections SET push_failure_count = push_failure_count + 1, updated_at = now()
     WHERE organization_id = $1 AND id = $2 RETURNING push_failure_count, status`,
    [organizationId, connectionId],
  );
  const count = Number(rows[0]?.push_failure_count ?? 0);
  if (count >= ERROR_THRESHOLD_FAILURES && rows[0]?.status === "active") {
    await pool.query(
      `UPDATE crm_connections SET status = 'error', updated_at = now() WHERE organization_id = $1 AND id = $2`,
      [organizationId, connectionId],
    );
    await logAudit({
      organizationId,
      actorLabel: "system",
      action: "crm_connection.errored",
      targetType: "crm_connection",
      targetId: connectionId,
      metadata: { provider, consecutiveFailures: count },
    });
  }
}

/** Lists recent deliveries for one connection, newest first, with lead names. */
export async function listPushDeliveries(
  organizationId: string,
  connectionId: string,
  options: { limit?: number } = {},
): Promise<CrmPushDelivery[]> {
  const { rows } = await getPool().query(
    `${SELECT_WITH_LEAD} WHERE d.organization_id = $1 AND d.connection_id = $2 ORDER BY d.created_at DESC LIMIT $3`,
    [organizationId, connectionId, Math.min(options.limit ?? 50, 200)],
  );
  return rows.map(mapRow);
}

export async function getPushDelivery(organizationId: string, deliveryId: string): Promise<CrmPushDelivery | null> {
  const { rows } = await getPool().query(`${SELECT_WITH_LEAD} WHERE d.organization_id = $1 AND d.id = $2`, [
    organizationId,
    deliveryId,
  ]);
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Manual retry: re-pushes the failed lead through the provider adapter and
 * updates the same delivery row. Retrying a succeeded delivery is rejected so
 * a double-click can't create duplicate CRM contacts.
 */
export async function retryPushDelivery(
  organizationId: string,
  connectionId: string,
  deliveryId: string,
  loadLeadFields: (organizationId: string, leadId: string) => Promise<Record<string, unknown> | null>,
): Promise<{ delivery: CrmPushDelivery | null; error?: string }> {
  const delivery = await getPushDelivery(organizationId, deliveryId);
  // Scope check before any side effect: the delivery must belong to the connection in the route.
  if (!delivery || delivery.connectionId !== connectionId) return { delivery: null, error: "Delivery not found." };
  if (delivery.status === "succeeded") return { delivery, error: "This delivery already succeeded — nothing to retry." };
  const connection = await getCrmConnection(organizationId, delivery.connectionId);
  if (!connection) return { delivery, error: "The connection for this delivery no longer exists." };
  const fields = await loadLeadFields(organizationId, delivery.leadId);
  if (!fields) return { delivery, error: "The lead for this delivery no longer exists." };

  const result = await pushLeadForProvider(connection.provider, connection.config, connection.fieldMapping, fields);
  await getPool().query(
    `UPDATE crm_push_deliveries
     SET status = $2, attempts = attempts + 1, last_status_code = $3, last_error = $4,
         delivered_at = CASE WHEN $2 = 'succeeded' THEN now() ELSE delivered_at END, updated_at = now()
     WHERE id = $1`,
    [deliveryId, result.ok ? "succeeded" : "failed", result.statusCode, result.ok ? null : result.message.slice(0, 500)],
  );
  await bumpFailureCount(organizationId, connection.id, connection.provider, result.ok);
  const updated = await getPushDelivery(organizationId, deliveryId);
  return { delivery: updated, ...(result.ok ? {} : { error: `Retry failed: ${result.message}` }) };
}
