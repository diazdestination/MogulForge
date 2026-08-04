import "server-only";
import { getPool } from "../db";
import { logAudit } from "../audit";
import { getCrmProvider, pushLeadForProvider } from "./adapters";
import { getCrmConnection } from "./store";
import { sendOrgAlertInBackground } from "../org-alerts";
import { buildCrmConnectionErrorEmail, buildCrmConnectionRecoveredEmail } from "../org-alerts-content.ts";
import { getOrgPortalBaseUrl } from "../custom-domains";

/**
 * Per-connection CRM push delivery log (mirrors the outgoing-webhook deliveries
 * pattern). Every outbound lead push — success or failure — is recorded so
 * clients can see exactly which leads reached their CRM and retry failures.
 * Repeated consecutive failures flip the connection status to 'error'.
 */

/** Consecutive push failures before a connection is flipped to 'error'. */
export const ERROR_THRESHOLD_FAILURES = 5;

/**
 * Automatic retry backoff (seconds) after attempt N fails: 1m, 5m, 30m, 2h, 8h;
 * then retries stop. Mirrors RETRY_BACKOFF_SECONDS in lib/webhooks/outgoing.ts.
 */
export const PUSH_RETRY_BACKOFF_SECONDS = [60, 300, 1800, 7200, 28800];
export const MAX_PUSH_ATTEMPTS = PUSH_RETRY_BACKOFF_SECONDS.length + 1;

/**
 * Next automatic retry time after `attempts` failed attempts, or null when
 * attempts are exhausted (a manual retry is still allowed past this point).
 */
function nextAttemptAfterFailure(attempts: number): Date | null {
  if (attempts >= MAX_PUSH_ATTEMPTS) return null;
  const backoff = PUSH_RETRY_BACKOFF_SECONDS[Math.min(attempts - 1, PUSH_RETRY_BACKOFF_SECONDS.length - 1)];
  return new Date(Date.now() + backoff * 1000);
}

/** Succeeded deliveries are kept this many days — long enough to audit recent pushes. */
export const SUCCEEDED_RETENTION_DAYS = 30;
/** Failed deliveries are kept longer so clients can still see and retry them. */
export const FAILED_RETENTION_DAYS = 90;

export type CrmPushDelivery = {
  id: string;
  organizationId: string;
  connectionId: string;
  leadId: string;
  leadName: string | null;
  provider: string;
  status: "succeeded" | "failed";
  attempts: number;
  nextAttemptAt: string | null;
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
    nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at as string).toISOString() : null,
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
    `INSERT INTO crm_push_deliveries (organization_id, connection_id, lead_id, provider, status, last_status_code, last_error, delivered_at, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      organizationId,
      input.connectionId,
      input.leadId,
      input.provider,
      input.ok ? "succeeded" : "failed",
      input.statusCode,
      input.ok ? null : input.message.slice(0, 500),
      input.ok ? new Date() : null,
      // Failed pushes get an automatic retry schedule (this row is attempt 1).
      input.ok ? null : nextAttemptAfterFailure(1),
    ],
  );
  await bumpFailureCount(organizationId, input.connectionId, input.provider, input.ok, input.message);
  return String(rows[0].id);
}

/** Resets the counter on success; on failure increments and flips the connection to 'error' at the threshold. */
async function bumpFailureCount(
  organizationId: string,
  connectionId: string,
  provider: string,
  ok: boolean,
  lastError: string | null = null,
): Promise<void> {
  const pool = getPool();
  if (ok) {
    // A success proves the connection works again — clear the counter and recover from 'error'.
    // The status='error' guard makes this statement match only when it performs
    // the error → active flip, so its row count is an exact recovery signal:
    // ordinary successes on an active connection fall through to the reset below.
    const recovered = await pool.query(
      `UPDATE crm_connections SET push_failure_count = 0, status = 'active', updated_at = now()
       WHERE organization_id = $1 AND id = $2 AND status = 'error'`,
      [organizationId, connectionId],
    );
    if ((recovered.rowCount ?? 0) === 0) {
      await pool.query(
        `UPDATE crm_connections SET push_failure_count = 0, updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND push_failure_count <> 0`,
        [organizationId, connectionId],
      );
    } else {
      await logAudit({
        organizationId,
        actorLabel: "system",
        action: "crm_connection.recovered",
        targetType: "crm_connection",
        targetId: connectionId,
        metadata: { provider },
      });
      await notifyConnectionRecovered(organizationId, connectionId, provider);
    }
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
    await notifyConnectionErrored(organizationId, connectionId, provider, count, lastError);
  }
}

/**
 * Emails the org's notification recipients when a connection flips to 'error'
 * so the outage surfaces before undelivered leads pile up. Fire-and-forget
 * delivery — an alert failure must never fail the push that triggered it —
 * and the crmConnectionAlerts toggle + saved addresses are honored inside
 * sendOrgAlert.
 */
async function notifyConnectionErrored(
  organizationId: string,
  connectionId: string,
  provider: string,
  consecutiveFailures: number,
  lastError: string | null,
): Promise<void> {
  try {
    const pool = getPool();
    const [orgRows, connection] = await Promise.all([
      pool.query("SELECT name FROM organizations WHERE id = $1", [organizationId]),
      getCrmConnection(organizationId, connectionId),
    ]);
    const orgName = orgRows.rows[0]?.name ? String(orgRows.rows[0].name) : "Your organization";
    const providerLabel = getCrmProvider(provider)?.label ?? provider;
    const portalBaseUrl = await getOrgPortalBaseUrl(organizationId);
    sendOrgAlertInBackground(
      organizationId,
      "crmConnectionAlerts",
      buildCrmConnectionErrorEmail({
        orgName,
        connectionName: connection?.name ?? providerLabel,
        providerLabel,
        consecutiveFailures,
        lastError,
        integrationsUrl: `${portalBaseUrl}/dashboard/revenue-rescue/integrations`,
      }),
    );
  } catch (error) {
    console.error(`CRM connection error alert failed for organization ${organizationId}`, error);
  }
}

/**
 * Emails the org's notification recipients when a connection recovers from
 * 'error' back to 'active' (a push succeeded again), closing the loop opened
 * by the outage email. Same crmConnectionAlerts toggle and fire-and-forget
 * semantics as notifyConnectionErrored.
 */
async function notifyConnectionRecovered(organizationId: string, connectionId: string, provider: string): Promise<void> {
  try {
    const pool = getPool();
    const [orgRows, connection] = await Promise.all([
      pool.query("SELECT name FROM organizations WHERE id = $1", [organizationId]),
      getCrmConnection(organizationId, connectionId),
    ]);
    const orgName = orgRows.rows[0]?.name ? String(orgRows.rows[0].name) : "Your organization";
    const providerLabel = getCrmProvider(provider)?.label ?? provider;
    const portalBaseUrl = await getOrgPortalBaseUrl(organizationId);
    sendOrgAlertInBackground(
      organizationId,
      "crmConnectionAlerts",
      buildCrmConnectionRecoveredEmail({
        orgName,
        connectionName: connection?.name ?? providerLabel,
        providerLabel,
        integrationsUrl: `${portalBaseUrl}/dashboard/revenue-rescue/integrations`,
      }),
    );
  } catch (error) {
    console.error(`CRM connection recovery alert failed for organization ${organizationId}`, error);
  }
}

/**
 * Retention pass: deletes succeeded deliveries older than 30 days and failed
 * ones older than 90 days (age by last activity, so a recently retried old
 * failure survives). Keeps the log useful without unbounded growth.
 */
export async function cleanupOldPushDeliveries(): Promise<{ succeededDeleted: number; failedDeleted: number }> {
  const pool = getPool();
  const succeeded = await pool.query(
    `DELETE FROM crm_push_deliveries WHERE status = 'succeeded' AND updated_at < now() - make_interval(days => $1)`,
    [SUCCEEDED_RETENTION_DAYS],
  );
  const failed = await pool.query(
    `DELETE FROM crm_push_deliveries WHERE status = 'failed' AND updated_at < now() - make_interval(days => $1)`,
    [FAILED_RETENTION_DAYS],
  );
  return { succeededDeleted: succeeded.rowCount ?? 0, failedDeleted: failed.rowCount ?? 0 };
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
  const clearSchedule = () =>
    getPool().query(`UPDATE crm_push_deliveries SET next_attempt_at = NULL, updated_at = now() WHERE id = $1`, [deliveryId]);
  const connection = await getCrmConnection(organizationId, delivery.connectionId);
  if (!connection) {
    // Unretryable — stop the background processor from picking this row up again.
    await clearSchedule();
    return { delivery, error: "The connection for this delivery no longer exists." };
  }
  const fields = await loadLeadFields(organizationId, delivery.leadId);
  if (!fields) {
    await clearSchedule();
    return { delivery, error: "The lead for this delivery no longer exists." };
  }

  const result = await pushLeadForProvider(connection.provider, connection.config, connection.fieldMapping, fields);
  await getPool().query(
    `UPDATE crm_push_deliveries
     SET status = $2, attempts = attempts + 1, last_status_code = $3, last_error = $4,
         delivered_at = CASE WHEN $2 = 'succeeded' THEN now() ELSE delivered_at END,
         next_attempt_at = $5, updated_at = now()
     WHERE id = $1`,
    [
      deliveryId,
      result.ok ? "succeeded" : "failed",
      result.statusCode,
      result.ok ? null : result.message.slice(0, 500),
      // Success clears the schedule; failure backs off until attempts run out.
      result.ok ? null : nextAttemptAfterFailure(delivery.attempts + 1),
    ],
  );
  await bumpFailureCount(organizationId, connection.id, connection.provider, result.ok, result.ok ? null : result.message);
  const updated = await getPushDelivery(organizationId, deliveryId);
  return { delivery: updated, ...(result.ok ? {} : { error: `Retry failed: ${result.message}` }) };
}
