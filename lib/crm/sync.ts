import "server-only";
import { getPool } from "../db";
import { logAudit } from "../audit";
import { pushLeadForProvider, pullContactsForProvider, type RemoteContact } from "./adapters";
import { recordPushDelivery, retryPushDelivery } from "./deliveries";
import { getCrmConnection, listCrmConnections, recordPullFailure, recordSyncConflict, updateCrmConnection, type CrmConnection } from "./store";
import { normalizeEmail, normalizePhone } from "../public-api/lead-intake";

/**
 * CRM sync engine.
 * Outbound: on lead.created, every active outbound/bidirectional connection
 * receives the mapped lead through its provider adapter.
 * Inbound: pull compares remote contacts against local leads and routes any
 * disagreement through crm_sync_conflicts — never silently overwriting newer data.
 */

/** Loads lead rows and shapes them into the LEAD_FIELDS objects mappings expect. */
async function loadLeadFieldsBatch(organizationId: string, leadIds: string[]): Promise<Array<{ id: string; fields: Record<string, unknown> }>> {
  if (leadIds.length === 0) return [];
  const { rows } = await getPool().query(
    `SELECT id, first_name, last_name, email, phone, address, city, state, zip, project_type, project_description,
            estimated_value, source, source_detail, external_record_id, status, notes
     FROM rescue_leads WHERE organization_id = $1 AND id = ANY($2)`,
    [organizationId, leadIds],
  );
  return rows.map((row) => ({ id: String(row.id), fields: shapeLeadFields(row) }));
}

/** Loads one lead's mapped fields — used by the delivery retry endpoint. */
export async function loadLeadFieldsForPush(organizationId: string, leadId: string): Promise<Record<string, unknown> | null> {
  const [lead] = await loadLeadFieldsBatch(organizationId, [leadId]);
  return lead?.fields ?? null;
}

function shapeLeadFields(row: Record<string, unknown>): Record<string, unknown> {
  return {
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    address: row.address,
    city: row.city,
    state: row.state,
    zip: row.zip,
    projectType: row.project_type,
    projectDescription: row.project_description,
    estimatedValue: row.estimated_value == null ? null : Number(row.estimated_value),
    source: row.source,
    sourceDetail: row.source_detail,
    externalRecordId: row.external_record_id,
    pipelineStage: row.status,
    score: null,
    notes: row.notes,
  };
}

async function outboundConnections(organizationId: string) {
  return (await listCrmConnections(organizationId)).filter(
    (c) => c.status === "active" && (c.syncDirection === "outbound" || c.syncDirection === "bidirectional"),
  );
}

/**
 * Pushes leads to every active outbound-capable CRM connection. Used by the
 * single-lead intake paths (one id) and the bulk import pipeline (many ids).
 * Failures are audited per connection; one bad connection never blocks the rest.
 */
export async function pushLeadsToCrmConnections(organizationId: string, leadIds: string[]): Promise<{ pushed: number; failed: number }> {
  const connections = await outboundConnections(organizationId);
  if (connections.length === 0 || leadIds.length === 0) return { pushed: 0, failed: 0 };

  let pushed = 0;
  let failed = 0;
  // Load + push in batches so huge imports never hold thousands of rows in memory.
  for (let i = 0; i < leadIds.length; i += 100) {
    const leads = await loadLeadFieldsBatch(organizationId, leadIds.slice(i, i + 100));
    for (const lead of leads) {
      for (const connection of connections) {
        const result = await pushLeadForProvider(connection.provider, connection.config, connection.fieldMapping, lead.fields);
        // Every outcome lands in the per-connection delivery log so clients can see and retry failures.
        await recordPushDelivery(organizationId, {
          connectionId: connection.id,
          leadId: lead.id,
          provider: connection.provider,
          ok: result.ok,
          statusCode: result.statusCode,
          message: result.message,
        }).catch((error) => console.error("CRM push delivery log failed", error));
        if (result.ok) {
          pushed += 1;
        } else {
          failed += 1;
          await logAudit({
            organizationId,
            actorLabel: "system",
            action: "crm_sync.push_failed",
            targetType: "crm_connection",
            targetId: connection.id,
            metadata: { provider: connection.provider, leadId: lead.id, message: result.message, statusCode: result.statusCode },
          });
        }
      }
    }
  }
  return { pushed, failed };
}

/** Fire-and-forget wrapper for request handlers. Never throws. */
export function pushLeadToCrmInBackground(organizationId: string, leadId: string) {
  pushLeadsToCrmConnections(organizationId, [leadId]).catch((error) => console.error("CRM lead push failed", error));
}

/** Fire-and-forget bulk wrapper for the import pipeline. Never throws. */
export function pushLeadsToCrmInBackground(organizationId: string, leadIds: string[]) {
  pushLeadsToCrmConnections(organizationId, leadIds).catch((error) => console.error("CRM bulk lead push failed", error));
}

/** Fields inbound pull may change; compared for conflict detection. */
const PULL_FIELDS: Array<{ key: keyof RemoteContact; field: string; column: string }> = [
  { key: "firstName", field: "firstName", column: "first_name" },
  { key: "lastName", field: "lastName", column: "last_name" },
];

export type PullSummary = {
  ok: boolean;
  message: string;
  matched: number;
  updated: number;
  conflicts: number;
  unmatched: number;
  /** Consecutive scheduled-pull failures recorded for this connection (0 after any success). */
  consecutiveFailures: number;
};

/**
 * Pulls recent contacts from the provider and reconciles them with local leads.
 * Remote changes only apply automatically when the remote copy is provably newer
 * AND the local field is empty-or-equal; otherwise a conflict is recorded.
 * Scheduled runs (options.scheduled) increment the connection's consecutive
 * failure counter on failure; any success resets it to zero.
 */
export async function pullCrmUpdates(
  organizationId: string,
  connection: CrmConnection,
  options: { scheduled?: boolean } = {},
): Promise<PullSummary> {
  const result = await pullContactsForProvider(connection.provider, connection.config);
  if (!result.ok) {
    const failure: PullSummary = { ok: false, message: result.message, matched: 0, updated: 0, conflicts: 0, unmatched: 0, consecutiveFailures: 0 };
    // Record failed pulls too, so the UI shows the outcome and the scheduler
    // waits a full interval instead of retrying a broken connection every pass.
    // The failure counter is incremented atomically inside the UPDATE itself,
    // so concurrent scheduler passes on multiple servers never lose or double
    // an increment (read-then-write in JS would race).
    const storedFailures = await recordPullFailure(
      organizationId,
      connection.id,
      { at: new Date().toISOString(), ...failure },
      { increment: Boolean(options.scheduled) },
    ).catch((error) => {
      console.error("CRM pull result save failed", error);
      return null;
    });
    failure.consecutiveFailures = storedFailures ?? (options.scheduled ? 1 : 0);
    return failure;
  }

  const pool = getPool();
  let matched = 0;
  let updated = 0;
  let conflicts = 0;
  let unmatched = 0;

  for (const contact of result.contacts) {
    const email = normalizeEmail(contact.email);
    const phone = normalizePhone(contact.phone);
    const conditions: string[] = [];
    const params: unknown[] = [organizationId];
    params.push(contact.externalRecordId);
    conditions.push(`external_record_id = $${params.length}`);
    if (email) {
      params.push(email);
      conditions.push(`email_normalized = $${params.length}`);
    }
    if (phone) {
      // Match on the last 10 digits so "+1 555 644 9001" (normalized
      // "15556449001") still finds a lead stored as "5556449001" — the same
      // US number with and without a country code.
      params.push(phone.slice(-10));
      conditions.push(`RIGHT(phone_normalized, 10) = $${params.length}`);
    }
    const { rows } = await pool.query(
      `SELECT id, first_name, last_name, updated_at FROM rescue_leads
       WHERE organization_id = $1 AND (${conditions.join(" OR ")}) ORDER BY updated_at DESC LIMIT 1`,
      params,
    );
    const lead = rows[0];
    if (!lead) {
      unmatched += 1;
      continue;
    }
    matched += 1;

    const changes: Array<{ field: string; column: string; localValue: unknown; remoteValue: unknown }> = [];
    for (const { key, field, column } of PULL_FIELDS) {
      const remoteValue = contact[key];
      if (remoteValue === null || remoteValue === undefined || remoteValue === "") continue;
      const localValue = lead[column];
      if (String(localValue ?? "") === String(remoteValue)) continue;
      changes.push({ field, column, localValue, remoteValue });
    }
    if (changes.length === 0) continue;

    const remoteUpdatedAt = contact.updatedAt && !Number.isNaN(Date.parse(contact.updatedAt)) ? new Date(contact.updatedAt) : null;
    const localUpdatedAt = lead.updated_at ? new Date(lead.updated_at) : null;
    const remoteIsProvablyNewer = remoteUpdatedAt && localUpdatedAt && remoteUpdatedAt.getTime() > localUpdatedAt.getTime();
    const localHasValues = changes.some((c) => c.localValue !== null && c.localValue !== "");

    if (!remoteIsProvablyNewer && localHasValues) {
      await recordSyncConflict(organizationId, {
        leadId: String(lead.id),
        connectionId: connection.id,
        source: `crm_pull:${connection.provider}`,
        fields: changes.map((c) => ({ field: c.field, localValue: c.localValue, remoteValue: c.remoteValue })),
        localUpdatedAt: localUpdatedAt?.toISOString() ?? null,
        remoteUpdatedAt: remoteUpdatedAt?.toISOString() ?? null,
      });
      conflicts += 1;
      continue;
    }

    const sets = changes.map((c, i) => `${c.column} = $${i + 3}`);
    await pool.query(
      `UPDATE rescue_leads SET ${sets.join(", ")}, updated_at = now() WHERE organization_id = $1 AND id = $2`,
      [organizationId, lead.id, ...changes.map((c) => c.remoteValue)],
    );
    updated += 1;
  }

  const summary: PullSummary = {
    ok: true,
    message: `Checked ${result.contacts.length} remote contacts: ${matched} matched, ${updated} updated, ${conflicts} conflicts recorded, ${unmatched} without a matching lead.`,
    matched,
    updated,
    conflicts,
    unmatched,
    consecutiveFailures: 0,
  };
  await updateCrmConnection(organizationId, connection.id, {
    lastTestResult: { ...(connection.lastTestResult ?? {}), lastPull: { at: new Date().toISOString(), ...summary } },
  });
  return summary;
}

/**
 * Background processor: re-pushes failed CRM push deliveries whose backoff
 * window has elapsed. Only deliveries on active connections are picked up —
 * disabled/error connections keep their rows (and next_attempt_at) untouched
 * so the manual Retry button still works, but automatic retries stop.
 * Each retry flows through retryPushDelivery, so attempts/backoff/exhaustion
 * and the connection failure counter behave exactly like a manual retry.
 */
export async function processDueCrmPushRetries(limit = 25): Promise<{ processed: number; recovered: number }> {
  const { rows } = await getPool().query(
    `SELECT d.id, d.organization_id, d.connection_id FROM crm_push_deliveries d
     JOIN crm_connections c ON c.id = d.connection_id
     WHERE d.status = 'failed' AND d.next_attempt_at IS NOT NULL AND d.next_attempt_at <= now()
       AND c.status = 'active'
     ORDER BY d.next_attempt_at ASC LIMIT $1`,
    [limit],
  );
  let recovered = 0;
  for (const row of rows) {
    const organizationId = String(row.organization_id);
    try {
      const { delivery } = await retryPushDelivery(organizationId, String(row.connection_id), String(row.id), loadLeadFieldsForPush);
      if (delivery?.status === "succeeded") recovered += 1;
      // A lead/connection that vanished leaves next_attempt_at set; clear it so
      // the processor never spins on an unretryable row.
      if (!delivery) {
        await getPool().query(`UPDATE crm_push_deliveries SET next_attempt_at = NULL, updated_at = now() WHERE id = $1`, [row.id]);
      }
    } catch (error) {
      console.error("Scheduled CRM push retry failed", { organizationId, deliveryId: String(row.id) }, error);
    }
  }
  return { processed: rows.length, recovered };
}

/** How often the scheduler pulls each active inbound-capable connection. */
export const SCHEDULED_PULL_INTERVAL_MINUTES = 15;

/**
 * After this many consecutive scheduled-pull failures the connection is flagged
 * status "error" and skipped by the scheduler until it is re-tested and
 * reactivated — mirroring the outgoing-webhook auto-disable pattern. At a
 * 15-minute interval this is roughly two hours of uninterrupted failures.
 */
export const SCHEDULED_PULL_AUTO_ERROR_FAILURES = 8;

/**
 * Background processor: pulls updates for every active inbound/bidirectional
 * connection whose last pull (success or failure) is older than the interval.
 * Results flow through the same pullCrmUpdates path as manual pulls, so
 * conflict detection and the per-connection lastPull record behave identically.
 * Per-connection failures are audited and never abort the pass.
 */
export async function runScheduledCrmPulls(limit = 10): Promise<{ pulled: number; failed: number }> {
  // Atomically claim connections that are due for a pull. The inner SELECT uses
  // FOR UPDATE SKIP LOCKED so two concurrent server instances can never claim
  // the same row in the same pass. The outer UPDATE immediately stamps
  // lastPull.at = now(), so any server that starts a new pass after this one
  // commits will see these rows as "recently pulled" and skip them for the full
  // interval — even if the actual pull has not finished yet. The real pull
  // result (pullCrmUpdates on success, recordPullFailure on failure) always
  // overwrites lastPull fully, so the claim stamp is never the final value.
  const { rows } = await getPool().query(
    `WITH claimed AS (
       SELECT id FROM crm_connections
       WHERE status = 'active'
         AND sync_direction IN ('inbound', 'bidirectional')
         AND provider IN ('hubspot', 'gohighlevel')
         AND (
           last_test_result->'lastPull'->>'at' IS NULL
           OR (last_test_result->'lastPull'->>'at')::timestamptz <= now() - ($1 || ' minutes')::interval
         )
       ORDER BY last_test_result->'lastPull'->>'at' ASC NULLS FIRST
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     UPDATE crm_connections SET
       last_test_result = COALESCE(last_test_result, '{}'::jsonb) ||
         jsonb_build_object(
           'lastPull',
           COALESCE(last_test_result->'lastPull', '{}'::jsonb) ||
           jsonb_build_object('at', to_json(now())#>>'{}')
         )
     WHERE id IN (SELECT id FROM claimed)
     RETURNING id, organization_id`,
    [String(SCHEDULED_PULL_INTERVAL_MINUTES), limit],
  );

  let pulled = 0;
  let failed = 0;
  for (const row of rows) {
    const organizationId = String(row.organization_id);
    const connectionId = String(row.id);
    try {
      const connection = await getCrmConnection(organizationId, connectionId);
      if (!connection || connection.status !== "active" || connection.syncDirection === "outbound") continue;
      const summary = await pullCrmUpdates(organizationId, connection, { scheduled: true });
      if (summary.ok) {
        pulled += 1;
      } else {
        failed += 1;
        await logAudit({
          organizationId,
          actorLabel: "system",
          action: "crm_sync.scheduled_pull_failed",
          targetType: "crm_connection",
          targetId: connectionId,
          metadata: { provider: connection.provider, message: summary.message, consecutiveFailures: summary.consecutiveFailures },
        }).catch((error) => console.error("CRM scheduled pull audit failed", error));
        if (summary.consecutiveFailures >= SCHEDULED_PULL_AUTO_ERROR_FAILURES) {
          // Flag the connection so clients see it needs attention and the
          // scheduler (which only selects status = 'active') stops calling a
          // broken API every interval. Reactivation requires a passing test.
          await updateCrmConnection(organizationId, connectionId, { status: "error" }).catch((error) =>
            console.error("CRM connection auto-error update failed", error),
          );
          await logAudit({
            organizationId,
            actorLabel: "system",
            action: "crm_connection.auto_errored",
            targetType: "crm_connection",
            targetId: connectionId,
            metadata: {
              provider: connection.provider,
              consecutiveFailures: summary.consecutiveFailures,
              threshold: SCHEDULED_PULL_AUTO_ERROR_FAILURES,
              message: summary.message,
            },
          }).catch((error) => console.error("CRM auto-error audit failed", error));
        }
      }
    } catch (error) {
      failed += 1;
      console.error("Scheduled CRM pull failed", { organizationId, connectionId }, error);
    }
  }
  return { pulled, failed };
}
