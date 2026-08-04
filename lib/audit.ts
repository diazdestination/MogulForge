import "server-only";
import { getPool } from "./db";

export type AuditEvent = {
  organizationId?: string | null;
  actorUserId?: string | null;
  actorLabel: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
};

/** Records an audit event. Failures are logged loudly but never break the calling flow. */
export async function logAudit(event: AuditEvent) {
  try {
    await getPool().query(
      `INSERT INTO audit_logs (organization_id, actor_user_id, actor_label, action, target_type, target_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        event.organizationId ?? null,
        event.actorUserId ?? null,
        event.actorLabel,
        event.action,
        event.targetType ?? null,
        event.targetId ?? null,
        JSON.stringify(event.metadata ?? {}),
      ],
    );
  } catch (error) {
    console.error("Failed to write audit log", event.action, error);
  }
}

/**
 * Retention: audit log rows are kept for 2 years, then pruned. Audit history
 * is deliberately kept much longer than delivery logs (compliance/debugging
 * value), but not forever — high-volume orgs would otherwise bloat the table
 * without bound. If indefinite retention is ever required, export to cold
 * storage before this window rather than removing the cleanup.
 */
export const AUDIT_RETENTION_DAYS = 730;

/** Deletes audit log rows older than the retention window. */
export async function cleanupOldAuditLogs(): Promise<{ deleted: number }> {
  const result = await getPool().query(
    `DELETE FROM audit_logs WHERE created_at < now() - make_interval(days => $1)`,
    [AUDIT_RETENTION_DAYS],
  );
  return { deleted: result.rowCount ?? 0 };
}

export type AuditLogRow = {
  id: string;
  organizationId: string | null;
  organizationName: string | null;
  actorUserId: string | null;
  actorLabel: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export async function listAuditLogs(options: { organizationId?: string; limit?: number } = {}): Promise<AuditLogRow[]> {
  const limit = Math.min(options.limit ?? 200, 500);
  const where = options.organizationId ? "WHERE a.organization_id = $2" : "";
  const params: unknown[] = [limit];
  if (options.organizationId) params.push(options.organizationId);
  const { rows } = await getPool().query(
    `SELECT a.*, o.name AS organization_name
     FROM audit_logs a LEFT JOIN organizations o ON o.id = a.organization_id
     ${where} ORDER BY a.created_at DESC LIMIT $1`,
    params,
  );
  return rows.map((row) => ({
    id: String(row.id),
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    actorUserId: row.actor_user_id,
    actorLabel: row.actor_label,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  }));
}
