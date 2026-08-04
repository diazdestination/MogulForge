import "server-only";
import { getPool } from "@/lib/db";

export type AnalyticsOpportunityInput = {
  kind: "query_spike";
  title: string;
  evidence: Record<string, unknown>;
  actionHint: string;
  dedupKey: string;
  leadId: null;
};

type SearchConsoleQuery = { key: string; clicks: number; impressions: number; ctr: number; position: number };

/**
 * Surfaces Search Console queries with high impressions but low CTR — a sign
 * that users are searching for services the org offers but not clicking through.
 * Threshold: ≥ 100 impressions and CTR < 5%.
 */
export async function getAnalyticsSignals(organizationId: string): Promise<AnalyticsOpportunityInput[]> {
  const { rows } = await getPool().query(
    `SELECT data FROM org_analytics_snapshots
     WHERE organization_id = $1 AND source = 'search_console' AND status = 'ok'`,
    [organizationId],
  );
  if (rows.length === 0) return [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- jsonb from DB
  const data = rows[0].data as any;
  const topQueries: SearchConsoleQuery[] = Array.isArray(data?.topQueries)
    ? (data.topQueries as SearchConsoleQuery[])
    : [];

  return topQueries
    .filter((q) => q.impressions >= 100 && q.ctr < 0.05)
    .slice(0, 10)
    .map((q) => ({
      kind: "query_spike" as const,
      title: `"${q.key}" gets ${q.impressions.toLocaleString()} monthly impressions but only ${(q.ctr * 100).toFixed(1)}% click through`,
      evidence: { query: q.key, impressions: q.impressions, clicks: q.clicks, ctr: q.ctr, position: q.position },
      actionHint:
        "A dedicated landing page optimized for this search query could convert this visibility into leads.",
      dedupKey: `gsc:${q.key.slice(0, 200)}`,
      leadId: null,
    }));
}
