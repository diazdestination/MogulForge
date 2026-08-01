import "server-only";
import { getPool } from "../db";
import { validateFieldMapping, type FieldMappingEntry } from "./mapping";

/** Tenant-scoped storage for CRM connections and sync conflicts. */

export type CrmConnection = {
  id: string;
  organizationId: string;
  provider: string;
  name: string;
  status: "draft" | "testing" | "active" | "disabled" | "error";
  syncDirection: "outbound" | "inbound" | "bidirectional";
  config: Record<string, unknown>;
  fieldMapping: FieldMappingEntry[];
  lastTestAt: string | null;
  lastTestResult: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

const COLUMNS = `id, organization_id, provider, name, status, sync_direction, config, field_mapping, last_test_at, last_test_result, created_at, updated_at`;

function mapRow(row: Record<string, unknown>): CrmConnection {
  const { mapping } = validateFieldMapping(row.field_mapping);
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    provider: String(row.provider),
    name: String(row.name),
    status: String(row.status) as CrmConnection["status"],
    syncDirection: String(row.sync_direction) as CrmConnection["syncDirection"],
    config: (row.config as Record<string, unknown>) ?? {},
    fieldMapping: mapping,
    lastTestAt: row.last_test_at ? new Date(row.last_test_at as string).toISOString() : null,
    lastTestResult: (row.last_test_result as Record<string, unknown>) ?? null,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

export async function createCrmConnection(
  organizationId: string,
  input: { provider: string; name: string; config?: Record<string, unknown>; createdBy?: string | null },
): Promise<CrmConnection> {
  const { rows } = await getPool().query(
    `INSERT INTO crm_connections (organization_id, provider, name, config, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
    [organizationId, input.provider, input.name, JSON.stringify(input.config ?? {}), input.createdBy ?? null],
  );
  return mapRow(rows[0]);
}

export async function listCrmConnections(organizationId: string): Promise<CrmConnection[]> {
  const { rows } = await getPool().query(
    `SELECT ${COLUMNS} FROM crm_connections WHERE organization_id = $1 ORDER BY created_at DESC`,
    [organizationId],
  );
  return rows.map(mapRow);
}

export async function getCrmConnection(organizationId: string, connectionId: string): Promise<CrmConnection | null> {
  const { rows } = await getPool().query(
    `SELECT ${COLUMNS} FROM crm_connections WHERE organization_id = $1 AND id = $2`,
    [organizationId, connectionId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function updateCrmConnection(
  organizationId: string,
  connectionId: string,
  patch: {
    name?: string;
    status?: CrmConnection["status"];
    syncDirection?: CrmConnection["syncDirection"];
    config?: Record<string, unknown>;
    fieldMapping?: FieldMappingEntry[];
    lastTestResult?: Record<string, unknown> | null;
    touchLastTest?: boolean;
  },
): Promise<CrmConnection | null> {
  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [organizationId, connectionId];
  const add = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (patch.name !== undefined) add("name", patch.name);
  if (patch.status !== undefined) add("status", patch.status);
  if (patch.syncDirection !== undefined) add("sync_direction", patch.syncDirection);
  if (patch.config !== undefined) add("config", JSON.stringify(patch.config));
  if (patch.fieldMapping !== undefined) add("field_mapping", JSON.stringify(patch.fieldMapping));
  if (patch.lastTestResult !== undefined) add("last_test_result", patch.lastTestResult === null ? null : JSON.stringify(patch.lastTestResult));
  if (patch.touchLastTest) sets.push("last_test_at = now()");
  const { rows } = await getPool().query(
    `UPDATE crm_connections SET ${sets.join(", ")} WHERE organization_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
    params,
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function deleteCrmConnection(organizationId: string, connectionId: string): Promise<boolean> {
  const result = await getPool().query(`DELETE FROM crm_connections WHERE organization_id = $1 AND id = $2`, [
    organizationId,
    connectionId,
  ]);
  return (result.rowCount ?? 0) > 0;
}

// ---- Sync conflicts -----------------------------------------------------------

export type SyncConflictField = { field: string; localValue: unknown; remoteValue: unknown };

export type SyncConflict = {
  id: string;
  organizationId: string;
  connectionId: string | null;
  leadId: string;
  leadName: string | null;
  source: string;
  fields: SyncConflictField[];
  localUpdatedAt: string | null;
  remoteUpdatedAt: string | null;
  status: "pending" | "applied_remote" | "kept_local" | "dismissed";
  createdAt: string;
};

export async function recordSyncConflict(
  organizationId: string,
  input: {
    leadId: string;
    connectionId?: string | null;
    source: string;
    fields: SyncConflictField[];
    localUpdatedAt: string | null;
    remoteUpdatedAt: string | null;
  },
): Promise<string> {
  const { rows } = await getPool().query(
    `INSERT INTO crm_sync_conflicts (organization_id, connection_id, lead_id, source, fields, local_updated_at, remote_updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [organizationId, input.connectionId ?? null, input.leadId, input.source, JSON.stringify(input.fields), input.localUpdatedAt, input.remoteUpdatedAt],
  );
  return String(rows[0].id);
}

export async function listSyncConflicts(
  organizationId: string,
  options: { status?: SyncConflict["status"]; limit?: number } = {},
): Promise<SyncConflict[]> {
  const params: unknown[] = [organizationId];
  let where = "c.organization_id = $1";
  if (options.status) {
    params.push(options.status);
    where += ` AND c.status = $${params.length}`;
  }
  params.push(Math.min(options.limit ?? 50, 200));
  const { rows } = await getPool().query(
    `SELECT c.*, l.first_name, l.last_name FROM crm_sync_conflicts c
     LEFT JOIN rescue_leads l ON l.id = c.lead_id
     WHERE ${where} ORDER BY c.created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map((row) => ({
    id: String(row.id),
    organizationId: String(row.organization_id),
    connectionId: row.connection_id ? String(row.connection_id) : null,
    leadId: String(row.lead_id),
    leadName: [row.first_name, row.last_name].filter(Boolean).join(" ") || null,
    source: String(row.source),
    fields: (row.fields as SyncConflictField[]) ?? [],
    localUpdatedAt: row.local_updated_at ? new Date(row.local_updated_at as string).toISOString() : null,
    remoteUpdatedAt: row.remote_updated_at ? new Date(row.remote_updated_at as string).toISOString() : null,
    status: String(row.status) as SyncConflict["status"],
    createdAt: new Date(row.created_at as string).toISOString(),
  }));
}

const FIELD_COLUMNS: Record<string, string> = {
  firstName: "first_name",
  lastName: "last_name",
  projectType: "project_type",
  projectDescription: "project_description",
  estimatedValue: "estimated_value",
  notes: "notes",
};

/**
 * Resolves a conflict. `apply_remote` writes the remote values onto the lead;
 * `keep_local` / `dismiss` leave the lead untouched. Always an explicit human choice.
 */
export async function resolveSyncConflict(
  organizationId: string,
  conflictId: string,
  resolution: "apply_remote" | "keep_local" | "dismiss",
  resolvedBy: string | null,
): Promise<SyncConflict | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, lead_id, fields, status FROM crm_sync_conflicts WHERE organization_id = $1 AND id = $2`,
    [organizationId, conflictId],
  );
  if (!rows[0] || rows[0].status !== "pending") return null;

  if (resolution === "apply_remote") {
    const fields = (rows[0].fields as SyncConflictField[]) ?? [];
    const applicable = fields.filter((f) => FIELD_COLUMNS[f.field]);
    if (applicable.length > 0) {
      const sets = applicable.map((f, i) => `${FIELD_COLUMNS[f.field]} = $${i + 3}`);
      await pool.query(
        `UPDATE rescue_leads SET ${sets.join(", ")}, updated_at = now() WHERE organization_id = $1 AND id = $2`,
        [organizationId, rows[0].lead_id, ...applicable.map((f) => f.remoteValue)],
      );
    }
  }
  const status = resolution === "apply_remote" ? "applied_remote" : resolution === "keep_local" ? "kept_local" : "dismissed";
  await pool.query(
    `UPDATE crm_sync_conflicts SET status = $3, resolved_by = $4, resolved_at = now() WHERE organization_id = $1 AND id = $2`,
    [organizationId, conflictId, status, resolvedBy],
  );
  const updated = await listSyncConflicts(organizationId, { limit: 200 });
  return updated.find((c) => c.id === conflictId) ?? null;
}
