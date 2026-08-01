import "server-only";
import { getPool } from "../db";
import { PIPELINE_STAGES, PIPELINE_VALUE_STAGES, type PipelineStage } from "./pipeline.ts";
import { listActivities, type Activity } from "./store.ts";

/**
 * Overview dashboard queries. All tenant-scoped; when `assignedUserId` is set
 * (sales reps), every lead-derived number is restricted to that rep's leads —
 * enforced here so no route can forget it.
 *
 * Honesty rule: simulated sends are counted as "simulated", never as sent or
 * delivered. Reply/opt-out rates are computed against contacted leads
 * regardless of mode (labelled in the UI), but delivered stays 0 until a real
 * provider exists.
 */

export type OverviewMetrics = {
  cards: {
    leadsImported: number;
    leadsAnalyzed: number;
    highPotential: number;
    activeConversations: number;
    appointmentsBooked: number;
    estimatesIssued: number;
    recoveredPipeline: number;
    wonRevenue: number;
    contactedLeads: number;
    simulatedSends: number;
    liveSends: number;
    delivered: number;
    replyRate: number | null;
    optOutRate: number | null;
  };
  funnel: Array<{ stage: PipelineStage; count: number }>;
  hotLeads: Array<{
    id: string;
    firstName: string | null;
    lastName: string | null;
    score: number | null;
    category: string | null;
    estimatedValue: number | null;
    projectType: string | null;
    pipelineStage: string;
    recommendedAction: string | null;
    assignedName: string | null;
  }>;
  campaignPerformance: Array<{
    id: string;
    name: string;
    channel: string;
    mode: string;
    status: string;
    enrolled: number;
    simulatedSends: number;
    delivered: number;
    replies: number;
    optOuts: number;
  }>;
  revenueOverTime: Array<{ month: string; pipeline: number; won: number }>;
  recentActivity: Activity[];
  openTasks: number;
};

export async function getOverviewMetrics(
  organizationId: string,
  opts: { assignedUserId?: string } = {},
): Promise<OverviewMetrics> {
  const pool = getPool();
  const leadParams: unknown[] = [organizationId];
  let leadScope = "";
  if (opts.assignedUserId) {
    leadParams.push(opts.assignedUserId);
    leadScope = ` AND assigned_user_id = $${leadParams.length}`;
  }

  const cardRows = await pool.query(
    `SELECT
       count(*)::int AS leads_imported,
       count(*) FILTER (WHERE analysis_status = 'analyzed')::int AS leads_analyzed,
       count(*) FILTER (WHERE category = 'hot_opportunity' OR score >= 70)::int AS high_potential,
       count(*) FILTER (WHERE pipeline_stage IN ('contacted', 'replied', 'qualified'))::int AS contacted_or_engaged,
       count(*) FILTER (WHERE pipeline_stage NOT IN ('imported', 'cleaned', 'analyzed', 'approved', 'suppressed'))::int AS contacted_total,
       count(*) FILTER (WHERE pipeline_stage = 'estimate_issued')::int AS estimates_issued,
       COALESCE(sum(estimated_value) FILTER (WHERE pipeline_stage = ANY($${leadParams.length + 1}::text[])), 0)::numeric AS recovered_pipeline,
       COALESCE(sum(COALESCE(won_value, estimated_value)) FILTER (WHERE pipeline_stage = 'won'), 0)::numeric AS won_revenue,
       count(*) FILTER (WHERE suppressed AND consent_status = 'opted_out')::int AS opted_out
     FROM rescue_leads WHERE organization_id = $1${leadScope}`,
    [...leadParams, [...PIPELINE_VALUE_STAGES]],
  );
  const c = cardRows.rows[0];

  // Message counters. Lead scoping joins through rescue_leads for reps.
  const msgJoin = opts.assignedUserId
    ? "JOIN rescue_leads l ON l.id = m.lead_id AND l.organization_id = m.organization_id AND l.assigned_user_id = $2"
    : "";
  const msgRows = await pool.query(
    `SELECT
       count(DISTINCT m.lead_id) FILTER (WHERE m.direction = 'outbound')::int AS contacted_leads,
       count(DISTINCT m.lead_id) FILTER (WHERE m.direction = 'inbound')::int AS replied_leads,
       count(*) FILTER (WHERE m.direction = 'outbound' AND m.simulated)::int AS simulated_sends,
       count(*) FILTER (WHERE m.direction = 'outbound' AND NOT m.simulated AND m.status IN ('sent', 'delivered'))::int AS live_sends,
       count(*) FILTER (WHERE m.direction = 'outbound' AND m.status = 'delivered')::int AS delivered,
       count(DISTINCT m.lead_id)::int AS conversation_leads
     FROM rescue_messages m ${msgJoin} WHERE m.organization_id = $1`,
    leadParams,
  );
  const m = msgRows.rows[0];

  const apptScope = opts.assignedUserId
    ? " AND (a.assigned_user_id = $2 OR EXISTS (SELECT 1 FROM rescue_leads l WHERE l.id = a.lead_id AND l.assigned_user_id = $2))"
    : "";
  const apptRows = await pool.query(
    `SELECT count(*)::int AS booked FROM rescue_appointments a
     WHERE a.organization_id = $1 AND a.status IN ('requested', 'confirmed', 'rescheduled', 'completed')${apptScope}`,
    leadParams,
  );

  const contacted = Number(m.contacted_leads);
  const replyRate = contacted > 0 ? Number(m.replied_leads) / contacted : null;
  const optOutRate = contacted > 0 ? Number(c.opted_out) / contacted : null;

  const funnelRows = await pool.query(
    `SELECT pipeline_stage, count(*)::int AS count FROM rescue_leads
     WHERE organization_id = $1${leadScope} GROUP BY pipeline_stage`,
    leadParams,
  );
  const funnelMap = new Map<string, number>(funnelRows.rows.map((r) => [r.pipeline_stage, r.count]));
  const funnel = PIPELINE_STAGES.map((stage) => ({ stage, count: funnelMap.get(stage) ?? 0 }));

  const hotRows = await pool.query(
    `SELECT l.id, l.first_name, l.last_name, l.score, l.category, l.estimated_value, l.project_type, l.pipeline_stage,
       l.analysis->'final'->>'recommendedAction' AS recommended_action, u.name AS assigned_name
     FROM rescue_leads l LEFT JOIN users u ON u.id = l.assigned_user_id
     WHERE l.organization_id = $1${leadScope.replaceAll("assigned_user_id", "l.assigned_user_id")}
       AND l.suppressed = false AND l.pipeline_stage NOT IN ('won', 'lost', 'suppressed')
       AND (l.category = 'hot_opportunity' OR l.score >= 70)
     ORDER BY l.score DESC NULLS LAST LIMIT 8`,
    leadParams,
  );

  // Campaign performance. For reps, every count is restricted to their
  // assigned leads and campaigns with none of their leads are omitted —
  // org-wide campaign stats are manager-only data.
  const repLeads = opts.assignedUserId
    ? ` AND EXISTS (SELECT 1 FROM rescue_leads rl WHERE rl.id = cl.lead_id AND rl.assigned_user_id = $2)`
    : "";
  const repMsgLeads = opts.assignedUserId
    ? ` AND EXISTS (SELECT 1 FROM rescue_leads rl WHERE rl.id = mm.lead_id AND rl.assigned_user_id = $2)`
    : "";
  const repCampaignFilter = opts.assignedUserId
    ? ` AND EXISTS (SELECT 1 FROM rescue_campaign_leads cl JOIN rescue_leads rl ON rl.id = cl.lead_id
         WHERE cl.campaign_id = c.id AND rl.assigned_user_id = $2)`
    : "";
  const campaignRows = await pool.query(
    `SELECT c.id, c.name, c.channel, c.mode, c.status,
       (SELECT count(*) FROM rescue_campaign_leads cl WHERE cl.campaign_id = c.id${repLeads})::int AS enrolled,
       (SELECT count(*) FROM rescue_messages mm WHERE mm.campaign_id = c.id AND mm.direction = 'outbound' AND mm.simulated${repMsgLeads})::int AS simulated_sends,
       (SELECT count(*) FROM rescue_messages mm WHERE mm.campaign_id = c.id AND mm.direction = 'outbound' AND mm.status = 'delivered'${repMsgLeads})::int AS delivered,
       (SELECT count(*) FROM rescue_campaign_leads cl WHERE cl.campaign_id = c.id AND cl.status = 'replied'${repLeads})::int AS replies,
       (SELECT count(*) FROM rescue_campaign_leads cl WHERE cl.campaign_id = c.id AND cl.status = 'stopped' AND cl.stop_reason = 'opt_out'${repLeads})::int AS opt_outs
     FROM rescue_campaigns c WHERE c.organization_id = $1 AND c.status <> 'archived'${repCampaignFilter}
     ORDER BY c.created_at DESC LIMIT 6`,
    leadParams,
  );

  // Revenue over time: leads grouped by the month they entered a value stage.
  const revenueRows = await pool.query(
    `SELECT to_char(date_trunc('month', stage_changed_at), 'YYYY-MM') AS month,
       COALESCE(sum(estimated_value) FILTER (WHERE pipeline_stage = ANY($${leadParams.length + 1}::text[])), 0)::numeric AS pipeline,
       COALESCE(sum(COALESCE(won_value, estimated_value)) FILTER (WHERE pipeline_stage = 'won'), 0)::numeric AS won
     FROM rescue_leads
     WHERE organization_id = $1${leadScope} AND stage_changed_at IS NOT NULL
       AND pipeline_stage = ANY($${leadParams.length + 2}::text[])
       AND stage_changed_at > now() - interval '6 months'
     GROUP BY 1 ORDER BY 1`,
    [...leadParams, [...PIPELINE_VALUE_STAGES], [...PIPELINE_VALUE_STAGES, "won"]],
  );

  // Reps count only tasks assigned to them or on their assigned leads —
  // unassigned org-wide tasks are manager work.
  const taskScope = opts.assignedUserId
    ? ` AND (assigned_user_id = $2 OR lead_id IN (SELECT id FROM rescue_leads WHERE organization_id = $1 AND assigned_user_id = $2))`
    : "";
  const taskRows = await pool.query(
    `SELECT count(*)::int AS open FROM rescue_tasks WHERE organization_id = $1 AND status = 'open'${taskScope}`,
    leadParams,
  );

  const recentActivity = await listActivities(organizationId, { limit: 12, assignedUserId: opts.assignedUserId });

  return {
    cards: {
      leadsImported: c.leads_imported,
      leadsAnalyzed: c.leads_analyzed,
      highPotential: c.high_potential,
      activeConversations: Number(m.conversation_leads),
      appointmentsBooked: apptRows.rows[0].booked,
      estimatesIssued: c.estimates_issued,
      recoveredPipeline: Number(c.recovered_pipeline),
      wonRevenue: Number(c.won_revenue),
      contactedLeads: contacted,
      simulatedSends: Number(m.simulated_sends),
      liveSends: Number(m.live_sends),
      delivered: Number(m.delivered),
      replyRate,
      optOutRate,
    },
    funnel,
    hotLeads: hotRows.rows.map((r) => ({
      id: r.id,
      firstName: r.first_name,
      lastName: r.last_name,
      score: r.score,
      category: r.category,
      estimatedValue: r.estimated_value != null ? Number(r.estimated_value) : null,
      projectType: r.project_type,
      pipelineStage: r.pipeline_stage,
      recommendedAction: r.recommended_action,
      assignedName: r.assigned_name,
    })),
    campaignPerformance: campaignRows.rows.map((r) => ({
      id: r.id,
      name: r.name,
      channel: r.channel,
      mode: r.mode,
      status: r.status,
      enrolled: r.enrolled,
      simulatedSends: r.simulated_sends,
      delivered: r.delivered,
      replies: r.replies,
      optOuts: r.opt_outs,
    })),
    revenueOverTime: revenueRows.rows.map((r) => ({ month: r.month, pipeline: Number(r.pipeline), won: Number(r.won) })),
    recentActivity,
    openTasks: taskRows.rows[0].open,
  };
}
