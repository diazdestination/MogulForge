import "server-only";
import { getPool } from "@/lib/db";

export type LeadOpportunityInput = {
  kind: "stale_estimate" | "hot_uncontacted";
  title: string;
  evidence: Record<string, unknown>;
  actionHint: string;
  dedupKey: string;
  leadId: string;
};

/** Open estimates > 60 days old that haven't been won or lost. */
async function staleEstimates(organizationId: string): Promise<LeadOpportunityInput[]> {
  const { rows } = await getPool().query(
    `SELECT id, first_name, last_name, estimate_date, estimated_value, project_type,
            EXTRACT(epoch FROM now() - estimate_date) / 86400 AS days_since
     FROM rescue_leads
     WHERE organization_id = $1
       AND pipeline_stage = 'estimate_issued'
       AND estimate_date IS NOT NULL
       AND estimate_date < now() - interval '60 days'
       AND suppressed = false
     ORDER BY estimate_date ASC
     LIMIT 50`,
    [organizationId],
  );
  return rows.map((r) => {
    const name = [r.first_name, r.last_name].filter(Boolean).join(" ") || "Unknown";
    const daysSince = Math.round(Number(r.days_since));
    return {
      kind: "stale_estimate" as const,
      title: `Open estimate for ${name} — ${daysSince} days with no update`,
      evidence: {
        leadId: r.id,
        name,
        estimateDate: r.estimate_date,
        daysSince,
        estimatedValue: r.estimated_value ? Number(r.estimated_value) : null,
        projectType: r.project_type,
      },
      actionHint: "Follow up on this open estimate before the lead goes cold.",
      dedupKey: String(r.id),
      leadId: String(r.id),
    };
  });
}

/**
 * High-score leads (score ≥ 7 or category = hot) that have never been
 * messaged, still in early pipeline stages, not suppressed.
 */
async function hotUncontacted(organizationId: string): Promise<LeadOpportunityInput[]> {
  const { rows } = await getPool().query(
    `SELECT rl.id, rl.first_name, rl.last_name, rl.score, rl.category,
            rl.project_type, rl.created_at,
            EXTRACT(epoch FROM now() - rl.created_at) / 86400 AS days_since_import,
            COUNT(rm.id) AS message_count
     FROM rescue_leads rl
     LEFT JOIN rescue_messages rm ON rm.lead_id = rl.id AND rm.direction = 'outbound'
     WHERE rl.organization_id = $1
       AND (rl.score >= 7 OR rl.category = 'hot')
       AND rl.pipeline_stage IN ('imported','cleaned','analyzed','approved')
       AND rl.suppressed = false
     GROUP BY rl.id
     HAVING COUNT(rm.id) = 0
     ORDER BY rl.score DESC NULLS LAST, rl.created_at ASC
     LIMIT 50`,
    [organizationId],
  );
  return rows.map((r) => {
    const name = [r.first_name, r.last_name].filter(Boolean).join(" ") || "Unknown";
    const daysSince = Math.round(Number(r.days_since_import));
    return {
      kind: "hot_uncontacted" as const,
      title: `High-score lead ${name} has never been contacted — ${daysSince} days since import`,
      evidence: {
        leadId: r.id,
        name,
        score: r.score != null ? Number(r.score) : null,
        category: r.category,
        projectType: r.project_type,
        daysSinceImport: daysSince,
      },
      actionHint: "Start a campaign or send a direct message to this high-priority lead.",
      dedupKey: String(r.id),
      leadId: String(r.id),
    };
  });
}

export async function getLeadSignals(organizationId: string): Promise<LeadOpportunityInput[]> {
  const [stale, hot] = await Promise.all([staleEstimates(organizationId), hotUncontacted(organizationId)]);
  return [...stale, ...hot];
}
