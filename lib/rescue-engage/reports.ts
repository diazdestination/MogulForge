import "server-only";
import { getPool } from "../db";
import { PIPELINE_STAGES, PIPELINE_VALUE_STAGES, type PipelineStage } from "./pipeline.ts";
import type { ReportRange } from "../report-range.ts";

export type { ReportRange } from "../report-range.ts";
export { parseReportDate } from "../report-range.ts";

/**
 * Reports page queries. All tenant-scoped; when `assignedUserId` is set
 * (sales reps), every lead-derived number is restricted to that rep's
 * assigned leads — enforced here so no route can forget it.
 *
 * Date semantics: `from`/`to` are YYYY-MM-DD calendar dates, inclusive on
 * both ends. Lead cohort numbers (leads added, funnel, breakdowns) use the
 * lead's created_at; engagement numbers use each message/appointment
 * timestamp; pipeline/won value uses stage_changed_at. Everything is
 * computed from real rows — an empty range reports zeros, never samples.
 */

export type ReportMetrics = {
  range: ReportRange;
  summary: {
    leadsAdded: number;
    leadsContacted: number;
    leadsReplied: number;
    outboundMessages: number;
    simulatedSends: number;
    liveSends: number;
    delivered: number;
    inboundMessages: number;
    optOuts: number;
    appointmentsBooked: number;
    recoveredPipeline: number;
    wonRevenue: number;
    wonCount: number;
    replyRate: number | null;
    optOutRate: number | null;
  };
  funnel: Array<{ stage: PipelineStage; count: number }>;
  campaigns: Array<{
    id: string;
    name: string;
    channel: string;
    mode: string;
    status: string;
    enrolled: number;
    outbound: number;
    simulatedSends: number;
    delivered: number;
    replies: number;
    optOuts: number;
  }>;
  sources: Array<{ source: string; leads: number; contacted: number; replied: number; pipelineValue: number; wonRevenue: number }>;
  categories: Array<{ category: string; leads: number; contacted: number; replied: number; pipelineValue: number; wonRevenue: number }>;
  trend: Array<{ bucket: string; outbound: number; inbound: number }>;
  trendGranularity: "day" | "week" | "month";
};

type Scope = { assignedUserId?: string };

/** Builds `col >= from AND col < to+1day` fragments, appending params. */
function rangeSql(column: string, range: ReportRange, params: unknown[]): string {
  let sql = "";
  if (range.from) {
    params.push(range.from);
    sql += ` AND ${column} >= $${params.length}::date`;
  }
  if (range.to) {
    params.push(range.to);
    sql += ` AND ${column} < ($${params.length}::date + interval '1 day')`;
  }
  return sql;
}

export async function getReportMetrics(
  organizationId: string,
  range: ReportRange,
  opts: Scope = {},
): Promise<ReportMetrics> {
  const pool = getPool();

  // ---- Lead cohort: leads created in range (current stage/value/breakdowns) ----
  const leadParams: unknown[] = [organizationId];
  let leadScope = "";
  if (opts.assignedUserId) {
    leadParams.push(opts.assignedUserId);
    leadScope = ` AND l.assigned_user_id = $${leadParams.length}`;
  }
  const leadRangeSql = rangeSql("l.created_at", range, leadParams);
  const leadWhere = `l.organization_id = $1${leadScope}${leadRangeSql}`;

  const funnelRows = await pool.query(
    `SELECT l.pipeline_stage, count(*)::int AS count FROM rescue_leads l WHERE ${leadWhere} GROUP BY 1`,
    leadParams,
  );
  const funnelMap = new Map<string, number>(funnelRows.rows.map((r) => [r.pipeline_stage, r.count]));
  const funnel = PIPELINE_STAGES.map((stage) => ({ stage, count: funnelMap.get(stage) ?? 0 }));
  const leadsAdded = funnel.reduce((sum, f) => sum + f.count, 0);

  const breakdownSelect = `
    count(*)::int AS leads,
    count(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM rescue_messages m WHERE m.organization_id = l.organization_id AND m.lead_id = l.id AND m.direction = 'outbound'
    ))::int AS contacted,
    count(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM rescue_messages m WHERE m.organization_id = l.organization_id AND m.lead_id = l.id AND m.direction = 'inbound'
    ))::int AS replied,
    COALESCE(sum(l.estimated_value) FILTER (WHERE l.pipeline_stage = ANY($${leadParams.length + 1}::text[])), 0)::numeric AS pipeline_value,
    COALESCE(sum(COALESCE(l.won_value, l.estimated_value)) FILTER (WHERE l.pipeline_stage = 'won'), 0)::numeric AS won_revenue`;
  const breakdownParams = [...leadParams, [...PIPELINE_VALUE_STAGES]];

  const sourceRows = await pool.query(
    `SELECT COALESCE(NULLIF(trim(l.source), ''), '(no source)') AS key, ${breakdownSelect}
     FROM rescue_leads l WHERE ${leadWhere} GROUP BY 1 ORDER BY leads DESC LIMIT 20`,
    breakdownParams,
  );
  const categoryRows = await pool.query(
    `SELECT COALESCE(l.category, 'uncategorized') AS key, ${breakdownSelect}
     FROM rescue_leads l WHERE ${leadWhere} GROUP BY 1 ORDER BY leads DESC LIMIT 20`,
    breakdownParams,
  );

  // ---- Pipeline value moved during the range (stage_changed_at) ----
  const valueParams: unknown[] = [organizationId];
  let valueScope = "";
  if (opts.assignedUserId) {
    valueParams.push(opts.assignedUserId);
    valueScope = ` AND l.assigned_user_id = $${valueParams.length}`;
  }
  const valueRangeSql = rangeSql("l.stage_changed_at", range, valueParams);
  const valueRows = await pool.query(
    `SELECT
       COALESCE(sum(l.estimated_value) FILTER (WHERE l.pipeline_stage = ANY($${valueParams.length + 1}::text[])), 0)::numeric AS recovered_pipeline,
       COALESCE(sum(COALESCE(l.won_value, l.estimated_value)) FILTER (WHERE l.pipeline_stage = 'won'), 0)::numeric AS won_revenue,
       count(*) FILTER (WHERE l.pipeline_stage = 'won')::int AS won_count,
       count(*) FILTER (WHERE l.pipeline_stage = 'suppressed' AND l.consent_status = 'opted_out')::int AS opt_outs
     FROM rescue_leads l
     WHERE l.organization_id = $1${valueScope} AND l.stage_changed_at IS NOT NULL${valueRangeSql}`,
    [...valueParams, [...PIPELINE_VALUE_STAGES]],
  );
  const v = valueRows.rows[0];

  // ---- Message activity in range ----
  const msgParams: unknown[] = [organizationId];
  let msgJoin = "";
  if (opts.assignedUserId) {
    msgParams.push(opts.assignedUserId);
    msgJoin = ` JOIN rescue_leads jl ON jl.id = m.lead_id AND jl.organization_id = m.organization_id AND jl.assigned_user_id = $${msgParams.length}`;
  }
  const msgRangeSql = rangeSql("m.created_at", range, msgParams);
  const msgRows = await pool.query(
    `SELECT
       count(DISTINCT m.lead_id) FILTER (WHERE m.direction = 'outbound')::int AS contacted_leads,
       count(DISTINCT m.lead_id) FILTER (WHERE m.direction = 'inbound')::int AS replied_leads,
       count(*) FILTER (WHERE m.direction = 'outbound')::int AS outbound,
       count(*) FILTER (WHERE m.direction = 'outbound' AND m.simulated)::int AS simulated_sends,
       count(*) FILTER (WHERE m.direction = 'outbound' AND NOT m.simulated AND m.status IN ('sent', 'delivered'))::int AS live_sends,
       count(*) FILTER (WHERE m.direction = 'outbound' AND m.status = 'delivered')::int AS delivered,
       count(*) FILTER (WHERE m.direction = 'inbound')::int AS inbound
     FROM rescue_messages m${msgJoin} WHERE m.organization_id = $1${msgRangeSql}`,
    msgParams,
  );
  const m = msgRows.rows[0];

  // ---- Appointments booked in range ----
  const apptParams: unknown[] = [organizationId];
  let apptScope = "";
  if (opts.assignedUserId) {
    apptParams.push(opts.assignedUserId);
    apptScope = ` AND (a.assigned_user_id = $${apptParams.length} OR EXISTS (
      SELECT 1 FROM rescue_leads jl WHERE jl.id = a.lead_id AND jl.organization_id = a.organization_id AND jl.assigned_user_id = $${apptParams.length}))`;
  }
  const apptRangeSql = rangeSql("a.created_at", range, apptParams);
  const apptRows = await pool.query(
    `SELECT count(*)::int AS booked FROM rescue_appointments a
     WHERE a.organization_id = $1 AND a.status NOT IN ('cancelled')${apptScope}${apptRangeSql}`,
    apptParams,
  );

  // ---- Campaign comparison: activity within the range per campaign ----
  const campParams: unknown[] = [organizationId];
  let repLeadFilter = "";
  let repCampaignFilter = "";
  if (opts.assignedUserId) {
    campParams.push(opts.assignedUserId);
    repLeadFilter = ` AND EXISTS (SELECT 1 FROM rescue_leads rl WHERE rl.id = mm.lead_id AND rl.organization_id = mm.organization_id AND rl.assigned_user_id = $${campParams.length})`;
    repCampaignFilter = ` AND EXISTS (SELECT 1 FROM rescue_campaign_leads cl JOIN rescue_leads rl ON rl.id = cl.lead_id
      WHERE cl.campaign_id = c.id AND rl.assigned_user_id = $${campParams.length})`;
  }
  const campMsgRange = rangeSql("mm.created_at", range, campParams);
  const enrolledFilter = opts.assignedUserId
    ? ` AND EXISTS (SELECT 1 FROM rescue_leads rl WHERE rl.id = cl.lead_id AND rl.assigned_user_id = $2)`
    : "";
  const campaignRows = await pool.query(
    `SELECT c.id, c.name, c.channel, c.mode, c.status,
       (SELECT count(*) FROM rescue_campaign_leads cl WHERE cl.campaign_id = c.id${enrolledFilter})::int AS enrolled,
       (SELECT count(*) FROM rescue_messages mm WHERE mm.campaign_id = c.id AND mm.direction = 'outbound'${repLeadFilter}${campMsgRange})::int AS outbound,
       (SELECT count(*) FROM rescue_messages mm WHERE mm.campaign_id = c.id AND mm.direction = 'outbound' AND mm.simulated${repLeadFilter}${campMsgRange})::int AS simulated_sends,
       (SELECT count(*) FROM rescue_messages mm WHERE mm.campaign_id = c.id AND mm.direction = 'outbound' AND mm.status = 'delivered'${repLeadFilter}${campMsgRange})::int AS delivered,
       (SELECT count(*) FROM rescue_messages mm WHERE mm.campaign_id = c.id AND mm.direction = 'inbound'${repLeadFilter}${campMsgRange})::int AS replies,
       (SELECT count(*) FROM rescue_messages mm WHERE mm.campaign_id = c.id AND mm.direction = 'inbound' AND mm.reply_category = 'opt_out'${repLeadFilter}${campMsgRange})::int AS opt_outs
     FROM rescue_campaigns c WHERE c.organization_id = $1 AND c.status <> 'archived'${repCampaignFilter}
     ORDER BY c.created_at DESC LIMIT 25`,
    campParams,
  );

  // ---- Message trend. Granularity scales with the range so bars stay readable. ----
  let granularity: "day" | "week" | "month" = "month";
  if (range.from && range.to) {
    const spanDays = (new Date(`${range.to}T00:00:00Z`).getTime() - new Date(`${range.from}T00:00:00Z`).getTime()) / 86400000;
    granularity = spanDays <= 35 ? "day" : spanDays <= 240 ? "week" : "month";
  }
  const trendParams: unknown[] = [organizationId];
  let trendJoin = "";
  if (opts.assignedUserId) {
    trendParams.push(opts.assignedUserId);
    trendJoin = ` JOIN rescue_leads jl ON jl.id = m.lead_id AND jl.organization_id = m.organization_id AND jl.assigned_user_id = $${trendParams.length}`;
  }
  let trendRange = rangeSql("m.created_at", range, trendParams);
  if (!range.from && !range.to) trendRange = " AND m.created_at > now() - interval '12 months'";
  const trendRows = await pool.query(
    `SELECT to_char(date_trunc('${granularity}', m.created_at), 'YYYY-MM-DD') AS bucket,
       count(*) FILTER (WHERE m.direction = 'outbound')::int AS outbound,
       count(*) FILTER (WHERE m.direction = 'inbound')::int AS inbound
     FROM rescue_messages m${trendJoin} WHERE m.organization_id = $1${trendRange}
     GROUP BY 1 ORDER BY 1 LIMIT 60`,
    trendParams,
  );

  const contacted = Number(m.contacted_leads);
  const optOuts = Number(v.opt_outs);
  const mapBreakdown = (rows: Array<Record<string, unknown>>) =>
    rows.map((r) => ({
      leads: Number(r.leads),
      contacted: Number(r.contacted),
      replied: Number(r.replied),
      pipelineValue: Number(r.pipeline_value),
      wonRevenue: Number(r.won_revenue),
    }));

  return {
    range,
    summary: {
      leadsAdded,
      leadsContacted: contacted,
      leadsReplied: Number(m.replied_leads),
      outboundMessages: Number(m.outbound),
      simulatedSends: Number(m.simulated_sends),
      liveSends: Number(m.live_sends),
      delivered: Number(m.delivered),
      inboundMessages: Number(m.inbound),
      optOuts,
      appointmentsBooked: apptRows.rows[0].booked,
      recoveredPipeline: Number(v.recovered_pipeline),
      wonRevenue: Number(v.won_revenue),
      wonCount: Number(v.won_count),
      replyRate: contacted > 0 ? Number(m.replied_leads) / contacted : null,
      optOutRate: contacted > 0 ? optOuts / contacted : null,
    },
    funnel,
    campaigns: campaignRows.rows.map((r) => ({
      id: r.id,
      name: r.name,
      channel: r.channel,
      mode: r.mode,
      status: r.status,
      enrolled: r.enrolled,
      outbound: r.outbound,
      simulatedSends: r.simulated_sends,
      delivered: r.delivered,
      replies: r.replies,
      optOuts: r.opt_outs,
    })),
    sources: sourceRows.rows.map((r, i) => ({ source: r.key, ...mapBreakdown(sourceRows.rows)[i] })),
    categories: categoryRows.rows.map((r, i) => ({ category: r.key, ...mapBreakdown(categoryRows.rows)[i] })),
    trend: trendRows.rows.map((r) => ({ bucket: r.bucket, outbound: r.outbound, inbound: r.inbound })),
    trendGranularity: granularity,
  };
}

export type ReportExportRow = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  source: string | null;
  sourceDetail: string | null;
  category: string | null;
  score: number | null;
  pipelineStage: string;
  estimatedValue: number | null;
  wonValue: number | null;
  consentStatus: string;
  suppressed: boolean;
  outboundMessages: number;
  inboundMessages: number;
  appointments: number;
  createdAt: string;
  stageChangedAt: string | null;
};

/** The underlying per-lead rows behind the report (same cohort + scoping as the metrics). */
export async function listReportRows(
  organizationId: string,
  range: ReportRange,
  opts: Scope = {},
): Promise<ReportExportRow[]> {
  const params: unknown[] = [organizationId];
  let scope = "";
  if (opts.assignedUserId) {
    params.push(opts.assignedUserId);
    scope = ` AND l.assigned_user_id = $${params.length}`;
  }
  const rangeFilter = rangeSql("l.created_at", range, params);
  const { rows } = await getPool().query(
    `SELECT l.id, l.first_name, l.last_name, l.email, l.phone, l.source, l.source_detail, l.category, l.score,
       l.pipeline_stage, l.estimated_value, l.won_value, l.consent_status, l.suppressed, l.created_at, l.stage_changed_at,
       (SELECT count(*) FROM rescue_messages m WHERE m.organization_id = l.organization_id AND m.lead_id = l.id AND m.direction = 'outbound')::int AS outbound_messages,
       (SELECT count(*) FROM rescue_messages m WHERE m.organization_id = l.organization_id AND m.lead_id = l.id AND m.direction = 'inbound')::int AS inbound_messages,
       (SELECT count(*) FROM rescue_appointments a WHERE a.organization_id = l.organization_id AND a.lead_id = l.id)::int AS appointments
     FROM rescue_leads l
     WHERE l.organization_id = $1${scope}${rangeFilter}
     ORDER BY l.created_at DESC LIMIT 10000`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    firstName: r.first_name,
    lastName: r.last_name,
    email: r.email,
    phone: r.phone,
    source: r.source,
    sourceDetail: r.source_detail,
    category: r.category,
    score: r.score,
    pipelineStage: r.pipeline_stage,
    estimatedValue: r.estimated_value != null ? Number(r.estimated_value) : null,
    wonValue: r.won_value != null ? Number(r.won_value) : null,
    consentStatus: r.consent_status,
    suppressed: r.suppressed,
    outboundMessages: r.outbound_messages,
    inboundMessages: r.inbound_messages,
    appointments: r.appointments,
    createdAt: r.created_at,
    stageChangedAt: r.stage_changed_at,
  }));
}
