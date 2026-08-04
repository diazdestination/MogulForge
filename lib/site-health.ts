import "server-only";
import { getPool } from "./db";

/**
 * Widget liveness: the embed loader pings a heartbeat whenever a module is
 * mounted on a client site (and every few minutes while the page stays open).
 * One row per (org, origin, module). Statuses are computed from last_seen_at —
 * never stored — so they are always honest.
 */

export type WidgetHeartbeat = {
  origin: string;
  module: string;
  firstSeenAt: string;
  lastSeenAt: string;
  beatCount: number;
};

export type WidgetLiveness = "live" | "recent" | "silent";

/** live: seen in the last 15 min · recent: last 24h · silent: older than 24h. */
export function widgetLiveness(lastSeenAt: string, now = Date.now()): WidgetLiveness {
  const age = now - new Date(lastSeenAt).getTime();
  if (age <= 15 * 60 * 1000) return "live";
  if (age <= 24 * 60 * 60 * 1000) return "recent";
  return "silent";
}

export async function recordWidgetHeartbeat(organizationId: string, origin: string, module: string): Promise<void> {
  await getPool().query(
    `INSERT INTO org_widget_heartbeats (organization_id, origin, module)
     VALUES ($1, $2, $3)
     ON CONFLICT (organization_id, origin, module)
     DO UPDATE SET last_seen_at = now(), beat_count = org_widget_heartbeats.beat_count + 1`,
    [organizationId, origin.slice(0, 300), module.slice(0, 40)],
  );
}

export async function listWidgetHeartbeats(organizationId: string): Promise<WidgetHeartbeat[]> {
  const { rows } = await getPool().query(
    `SELECT origin, module, first_seen_at, last_seen_at, beat_count
     FROM org_widget_heartbeats WHERE organization_id = $1 ORDER BY last_seen_at DESC`,
    [organizationId],
  );
  return rows.map((r) => ({
    origin: r.origin,
    module: r.module,
    firstSeenAt: r.first_seen_at instanceof Date ? r.first_seen_at.toISOString() : String(r.first_seen_at),
    lastSeenAt: r.last_seen_at instanceof Date ? r.last_seen_at.toISOString() : String(r.last_seen_at),
    beatCount: Number(r.beat_count),
  }));
}

/** Leads created in the trailing N days — the "traffic → leads" half of the analytics view. */
export async function countRecentLeads(organizationId: string, days = 28): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT count(*)::int AS n FROM rescue_leads WHERE organization_id = $1 AND created_at >= now() - ($2 || ' days')::interval`,
    [organizationId, String(days)],
  );
  return Number(rows[0]?.n ?? 0);
}
