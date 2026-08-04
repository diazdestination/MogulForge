import "server-only";
import { getPool } from "../db";
import { logAudit } from "../audit";
import { pushLeadForProvider, pullContactsForProvider, type RemoteContact } from "./adapters";
import { recordPushDelivery } from "./deliveries";
import { listCrmConnections, recordSyncConflict, updateCrmConnection, type CrmConnection } from "./store";
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

export type PullSummary = { ok: boolean; message: string; matched: number; updated: number; conflicts: number; unmatched: number };

/**
 * Pulls recent contacts from the provider and reconciles them with local leads.
 * Remote changes only apply automatically when the remote copy is provably newer
 * AND the local field is empty-or-equal; otherwise a conflict is recorded.
 */
export async function pullCrmUpdates(organizationId: string, connection: CrmConnection): Promise<PullSummary> {
  const result = await pullContactsForProvider(connection.provider, connection.config);
  if (!result.ok) return { ok: false, message: result.message, matched: 0, updated: 0, conflicts: 0, unmatched: 0 };

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
      params.push(phone);
      conditions.push(`phone_normalized = $${params.length}`);
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
  };
  await updateCrmConnection(organizationId, connection.id, {
    lastTestResult: { ...(connection.lastTestResult ?? {}), lastPull: { at: new Date().toISOString(), ...summary } },
  });
  return summary;
}
