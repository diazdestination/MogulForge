import "server-only";
import { getPool } from "@/lib/db";
import { getLeadSignals } from "./signals/leads-signal";
import { getCrawlSignals } from "./signals/crawl-signal";
import { getAnalyticsSignals } from "./signals/analytics-signal";
import { getGbpSignals, type GbpSignalResult } from "./signals/gbp-signal";

export type OpportunityKind = "stale_estimate" | "hot_uncontacted" | "no_cta_page" | "query_spike" | "gbp_review";

export type Opportunity = {
  id: string;
  organizationId: string;
  runId: string | null;
  kind: OpportunityKind;
  title: string;
  evidence: Record<string, unknown>;
  actionHint: string;
  status: "new" | "actioned" | "dismissed";
  dedupKey: string;
  leadId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GbpConnectionStatus = GbpSignalResult["status"];

export type RunDiscoveryResult = {
  runId: string;
  opportunitiesAdded: number;
  gbpStatus: GbpConnectionStatus;
};

/**
 * Runs all signal adapters for an org, upserts new opportunities, and preserves
 * dismissed/actioned ones across re-runs. Always completes the run row (even on
 * partial failure) so the history is honest.
 */
export async function runDiscoveryForOrg(organizationId: string): Promise<RunDiscoveryResult> {
  const pool = getPool();
  const { rows: runRows } = await pool.query(
    `INSERT INTO org_discovery_runs (organization_id) VALUES ($1) RETURNING id`,
    [organizationId],
  );
  const runId = String(runRows[0].id);

  let opportunitiesAdded = 0;
  let gbpStatus: GbpConnectionStatus = "not_connected";

  try {
    const [leadSignals, crawlSignals, analyticsSignals, gbpResult] = await Promise.all([
      getLeadSignals(organizationId).catch((e) => { console.error("Lead signals failed", e); return []; }),
      getCrawlSignals(organizationId).catch((e) => { console.error("Crawl signals failed", e); return []; }),
      getAnalyticsSignals(organizationId).catch((e) => { console.error("Analytics signals failed", e); return []; }),
      getGbpSignals(organizationId).catch((e) => {
        console.error("GBP signals failed", e);
        return { status: "error" as const, error: String(e) };
      }),
    ]);

    gbpStatus = gbpResult.status;
    const gbpSignals = gbpResult.status === "ok" ? gbpResult.opportunities : [];
    const allSignals = [...leadSignals, ...crawlSignals, ...analyticsSignals, ...gbpSignals];

    for (const signal of allSignals) {
      const { rowCount } = await pool.query(
        `INSERT INTO org_opportunities
           (organization_id, run_id, kind, title, evidence, action_hint, dedup_key, lead_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (organization_id, kind, dedup_key)
         WHERE status = 'new'
         DO NOTHING`,
        [
          organizationId,
          runId,
          signal.kind,
          signal.title,
          JSON.stringify(signal.evidence),
          signal.actionHint,
          signal.dedupKey,
          signal.leadId ?? null,
        ],
      );
      if ((rowCount ?? 0) > 0) opportunitiesAdded++;
    }

    await pool.query(
      `UPDATE org_discovery_runs SET status='complete', opportunities_found=$2, finished_at=now() WHERE id=$1`,
      [runId, opportunitiesAdded],
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    await pool
      .query(`UPDATE org_discovery_runs SET status='failed', error=$2, finished_at=now() WHERE id=$1`, [runId, msg])
      .catch(() => {});
    throw error;
  }

  return { runId, opportunitiesAdded, gbpStatus };
}

/** Lists opportunities for an org, newest first. */
export async function listOpportunities(
  organizationId: string,
  opts: { includeActioned?: boolean; includeDismissed?: boolean } = {},
): Promise<Opportunity[]> {
  const statuses = ["new", ...(opts.includeActioned ? ["actioned"] : []), ...(opts.includeDismissed ? ["dismissed"] : [])];
  const placeholders = statuses.map((_, i) => `$${i + 2}`).join(",");
  const { rows } = await getPool().query(
    `SELECT id, organization_id, run_id, kind, title, evidence, action_hint,
            status, dedup_key, lead_id, created_at, updated_at
     FROM org_opportunities
     WHERE organization_id = $1 AND status IN (${placeholders})
     ORDER BY created_at DESC LIMIT 200`,
    [organizationId, ...statuses],
  );
  return rows.map((r) => ({
    id: String(r.id),
    organizationId: String(r.organization_id),
    runId: r.run_id ? String(r.run_id) : null,
    kind: r.kind as OpportunityKind,
    title: String(r.title),
    evidence: r.evidence as Record<string, unknown>,
    actionHint: String(r.action_hint),
    status: r.status as Opportunity["status"],
    dedupKey: String(r.dedup_key),
    leadId: r.lead_id ? String(r.lead_id) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }));
}

/** Updates the status of a single opportunity (must belong to the org). */
export async function updateOpportunityStatus(
  organizationId: string,
  opportunityId: string,
  status: "actioned" | "dismissed",
): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE org_opportunities SET status=$3, updated_at=now() WHERE id=$1 AND organization_id=$2`,
    [opportunityId, organizationId, status],
  );
  return (rowCount ?? 0) > 0;
}

/** All active orgs with revenue_rescue entitlement — used by the cron job. */
export async function listOrgsForDiscovery(): Promise<string[]> {
  const { rows } = await getPool().query(
    `SELECT DISTINCT o.id
     FROM organizations o
     JOIN entitlements e ON e.organization_id = o.id
     WHERE o.status = 'active'
       AND e.feature_key = 'revenue_rescue'
       AND e.enabled = true`,
  );
  return rows.map((r) => String(r.id));
}
