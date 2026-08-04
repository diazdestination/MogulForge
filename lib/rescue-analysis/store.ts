import "server-only";
import { getPool } from "../db";
import type { AnalysisStatus, LeadCategory } from "./categories.ts";
import type { LeadFacts } from "./signals.ts";
import type { FinalAnalysis } from "./merge.ts";
import type { DeterministicAnalysis } from "./signals.ts";
import type { AiAnalysis } from "./ai-schema.ts";
import type { MessageType } from "./message-content.ts";

/**
 * Tenant-scoped data layer for lead analysis + message drafts. Every query is
 * scoped by organizationId — org ids from URLs are validated by the API guard
 * before they reach here.
 */

// ---- Analysis runs -----------------------------------------------------------

export const RUN_STATUSES = ["running", "complete", "partial", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** A run with no progress update for this long is considered orphaned. */
export const STALE_RUN_MINUTES = 10;

export type AnalysisRun = {
  id: string;
  organizationId: string;
  importId: string | null;
  createdBy: string | null;
  status: RunStatus;
  mode: "hybrid" | "deterministic";
  totalCount: number;
  analyzedCount: number;
  aiCount: number;
  failedCount: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

const RUN_COLUMNS = `id, organization_id, import_id, created_by, status, mode,
  total_count, analyzed_count, ai_count, failed_count, error, created_at, updated_at`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRun(row: any): AnalysisRun {
  return {
    id: row.id,
    organizationId: row.organization_id,
    importId: row.import_id,
    createdBy: row.created_by,
    status: row.status,
    mode: row.mode,
    totalCount: row.total_count,
    analyzedCount: row.analyzed_count,
    aiCount: row.ai_count,
    failedCount: row.failed_count,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Atomically creates a run — returns null when another run is already active.
 * The partial unique index `lead_analysis_runs_one_active_idx` (one row per
 * org WHERE status = 'running') is the arbiter, so two concurrent callers can
 * never both win: exactly one INSERT succeeds, the other hits ON CONFLICT.
 */
export async function tryCreateAnalysisRun(input: {
  organizationId: string;
  importId?: string | null;
  createdBy?: string | null;
  mode: "hybrid" | "deterministic";
  totalCount: number;
}): Promise<AnalysisRun | null> {
  const { rows } = await getPool().query(
    `INSERT INTO lead_analysis_runs (organization_id, import_id, created_by, mode, total_count)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (organization_id) WHERE status = 'running' DO NOTHING
     RETURNING ${RUN_COLUMNS}`,
    [input.organizationId, input.importId ?? null, input.createdBy ?? null, input.mode, input.totalCount],
  );
  return rows[0] ? mapRun(rows[0]) : null;
}

/** Removes a run that never processed anything (e.g. created, then zero leads found). */
export async function deleteAnalysisRun(organizationId: string, runId: string): Promise<void> {
  await getPool().query("DELETE FROM lead_analysis_runs WHERE organization_id = $1 AND id = $2", [organizationId, runId]);
}

/**
 * Marks orphaned runs (still 'running' but with no progress update for
 * STALE_RUN_MINUTES — e.g. the server restarted mid-run) as failed so the
 * one-active-run unique index frees up for the next start.
 */
export async function reapStaleRuns(organizationId: string): Promise<number> {
  const { rowCount } = await getPool().query(
    `UPDATE lead_analysis_runs
     SET status = 'failed', error = 'Run was interrupted (no progress for ${STALE_RUN_MINUTES}+ minutes). Its remaining leads return to the queue for the next run.', updated_at = now()
     WHERE organization_id = $1 AND status = 'running' AND updated_at < now() - make_interval(mins => $2)`,
    [organizationId, STALE_RUN_MINUTES],
  );
  return rowCount ?? 0;
}

/**
 * Returns leads stranded in 'analyzing' (their run died mid-flight) to
 * 'pending' so the next run picks them up. Only touches stale rows — an
 * active run refreshes updated_at when it claims each batch, so its
 * in-flight leads are never stolen.
 */
export async function reclaimStrandedLeads(organizationId: string): Promise<number> {
  const { rowCount } = await getPool().query(
    `UPDATE rescue_leads SET analysis_status = 'pending', updated_at = now()
     WHERE organization_id = $1 AND analysis_status = 'analyzing' AND updated_at < now() - make_interval(mins => $2)`,
    [organizationId, STALE_RUN_MINUTES],
  );
  return rowCount ?? 0;
}

export async function getAnalysisRun(organizationId: string, runId: string): Promise<AnalysisRun | null> {
  const { rows } = await getPool().query(
    `SELECT ${RUN_COLUMNS} FROM lead_analysis_runs WHERE organization_id = $1 AND id = $2`,
    [organizationId, runId],
  );
  return rows[0] ? mapRun(rows[0]) : null;
}

export async function listAnalysisRuns(organizationId: string, limit = 20): Promise<AnalysisRun[]> {
  const { rows } = await getPool().query(
    `SELECT ${RUN_COLUMNS} FROM lead_analysis_runs WHERE organization_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [organizationId, Math.min(limit, 100)],
  );
  return rows.map(mapRun);
}

export async function latestRunForImport(organizationId: string, importId: string): Promise<AnalysisRun | null> {
  const { rows } = await getPool().query(
    `SELECT ${RUN_COLUMNS} FROM lead_analysis_runs WHERE organization_id = $1 AND import_id = $2
     ORDER BY created_at DESC LIMIT 1`,
    [organizationId, importId],
  );
  return rows[0] ? mapRun(rows[0]) : null;
}

/** An org's currently active run (running + fresh lease), if any. */
export async function getActiveRun(organizationId: string): Promise<AnalysisRun | null> {
  const { rows } = await getPool().query(
    `SELECT ${RUN_COLUMNS} FROM lead_analysis_runs
     WHERE organization_id = $1 AND status = 'running' AND updated_at > now() - make_interval(mins => $2)
     ORDER BY created_at DESC LIMIT 1`,
    [organizationId, STALE_RUN_MINUTES],
  );
  return rows[0] ? mapRun(rows[0]) : null;
}

export async function updateRunProgress(
  organizationId: string,
  runId: string,
  progress: Partial<{ status: RunStatus; totalCount: number; analyzedCount: number; aiCount: number; failedCount: number; error: string | null }>,
): Promise<void> {
  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [organizationId, runId];
  const columnFor: Record<string, string> = {
    status: "status",
    totalCount: "total_count",
    analyzedCount: "analyzed_count",
    aiCount: "ai_count",
    failedCount: "failed_count",
    error: "error",
  };
  for (const [key, column] of Object.entries(columnFor)) {
    const value = progress[key as keyof typeof progress];
    if (value !== undefined) {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    }
  }
  await getPool().query(
    `UPDATE lead_analysis_runs SET ${sets.join(", ")} WHERE organization_id = $1 AND id = $2`,
    params,
  );
}

// ---- Leads for analysis --------------------------------------------------------

export type LeadForAnalysis = { id: string } & LeadFacts;

export const LEAD_FACT_COLUMNS = `id, first_name, last_name, email, email_normalized, phone, phone_normalized,
  address, city, state, zip, project_type, project_description, estimated_value, source, source_detail,
  first_contact_date::text AS first_contact_date, last_contact_date::text AS last_contact_date,
  estimate_date::text AS estimate_date, consent_status, suppressed, suppression_reason, status, notes`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapLeadFacts(row: any): LeadForAnalysis {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    emailNormalized: row.email_normalized,
    phone: row.phone,
    phoneNormalized: row.phone_normalized,
    address: row.address,
    city: row.city,
    state: row.state,
    zip: row.zip,
    projectType: row.project_type,
    projectDescription: row.project_description,
    estimatedValue: row.estimated_value != null ? Number(row.estimated_value) : null,
    source: row.source,
    sourceDetail: row.source_detail,
    firstContactDate: row.first_contact_date,
    lastContactDate: row.last_contact_date,
    estimateDate: row.estimate_date,
    consentStatus: row.consent_status,
    suppressed: row.suppressed,
    suppressionReason: row.suppression_reason,
    status: row.status,
    notes: row.notes,
  };
}

/** Leads awaiting analysis (pending or previously failed), oldest first. */
export async function listLeadsForAnalysis(
  organizationId: string,
  opts: { importId?: string | null; limit: number },
): Promise<LeadForAnalysis[]> {
  const params: unknown[] = [organizationId];
  let where = "organization_id = $1 AND analysis_status IN ('pending', 'failed')";
  if (opts.importId) {
    params.push(opts.importId);
    where += ` AND import_id = $${params.length}`;
  }
  params.push(opts.limit);
  const { rows } = await getPool().query(
    `SELECT ${LEAD_FACT_COLUMNS} FROM rescue_leads WHERE ${where} ORDER BY created_at ASC LIMIT $${params.length}`,
    params,
  );
  return rows.map(mapLeadFacts);
}

export async function markLeadsAnalyzing(organizationId: string, leadIds: string[]): Promise<void> {
  if (leadIds.length === 0) return;
  await getPool().query(
    `UPDATE rescue_leads SET analysis_status = 'analyzing', analysis_error = NULL, updated_at = now()
     WHERE organization_id = $1 AND id = ANY($2)`,
    [organizationId, leadIds],
  );
}

export type StoredAnalysis = {
  mode: "hybrid" | "deterministic";
  deterministic: Pick<DeterministicAnalysis, "score" | "category" | "signals" | "flags">;
  ai: AiAnalysis | null;
  aiError: string | null;
  final: FinalAnalysis;
  analyzedAt: string;
};

export async function saveLeadAnalysis(organizationId: string, leadId: string, analysis: StoredAnalysis): Promise<void> {
  await getPool().query(
    `UPDATE rescue_leads SET analysis_status = 'analyzed', score = $3, category = $4, needs_review = $5,
       analysis = $6::jsonb, analysis_error = NULL, analyzed_at = now(), updated_at = now()
     WHERE organization_id = $1 AND id = $2`,
    [organizationId, leadId, analysis.final.score, analysis.final.category, analysis.final.needsReview, JSON.stringify(analysis)],
  );
}

export async function markLeadAnalysisFailed(organizationId: string, leadId: string, message: string): Promise<void> {
  await getPool().query(
    `UPDATE rescue_leads SET analysis_status = 'failed', analysis_error = $3, updated_at = now()
     WHERE organization_id = $1 AND id = $2`,
    [organizationId, leadId, message.slice(0, 500)],
  );
}

/** How many of the given leads ended up classified as hot_opportunity. */
export async function countHotLeadsAmong(organizationId: string, leadIds: string[]): Promise<number> {
  if (leadIds.length === 0) return 0;
  const { rows } = await getPool().query(
    `SELECT count(*)::int AS n FROM rescue_leads
     WHERE organization_id = $1 AND id = ANY($2) AND category = 'hot_opportunity'`,
    [organizationId, leadIds],
  );
  return rows[0]?.n ?? 0;
}

/** Most recent stated service area from the org's intake submissions (if any). */
export async function getOrgServiceArea(organizationId: string): Promise<string | null> {
  const { rows } = await getPool().query(
    `SELECT company->>'serviceArea' AS service_area FROM rescue_intakes
     WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [organizationId],
  );
  const value = rows[0]?.service_area;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

// ---- Lead listing / detail (dashboard hooks) ------------------------------------

export type LeadListItem = {
  id: string;
  importId: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  projectType: string | null;
  estimatedValue: number | null;
  source: string | null;
  consentStatus: string;
  suppressed: boolean;
  status: string;
  analysisStatus: AnalysisStatus;
  score: number | null;
  category: LeadCategory | null;
  needsReview: boolean;
  analyzedAt: string | null;
  createdAt: string;
  pipelineStage: string;
  assignedUserId: string | null;
  assignedName: string | null;
  lastContactDate: string | null;
};

export const LEAD_SORT_KEYS = ["score", "created", "value", "last_contact", "name"] as const;
export type LeadSortKey = (typeof LEAD_SORT_KEYS)[number];

const SORT_SQL: Record<LeadSortKey, string> = {
  score: "l.score",
  created: "l.created_at",
  value: "l.estimated_value",
  last_contact: "l.last_contact_date",
  name: "lower(coalesce(l.last_name, '') || coalesce(l.first_name, ''))",
};

export async function listLeads(
  organizationId: string,
  opts: {
    importId?: string;
    category?: string;
    analysisStatus?: string;
    needsReview?: boolean;
    search?: string;
    source?: string;
    projectType?: string;
    minScore?: number;
    stage?: string;
    campaignId?: string;
    /** 'none' = unassigned; a user id = assigned to that user. */
    assignedTo?: string;
    createdFrom?: string;
    createdTo?: string;
    suppressed?: boolean;
    /** Hard restriction for sales reps — forced server-side, combines with assignedTo. */
    restrictToUserId?: string;
    sort?: LeadSortKey;
    dir?: "asc" | "desc";
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ leads: LeadListItem[]; total: number }> {
  const params: unknown[] = [organizationId];
  const where: string[] = ["l.organization_id = $1"];
  if (opts.importId) {
    params.push(opts.importId);
    where.push(`l.import_id = $${params.length}`);
  }
  if (opts.category) {
    params.push(opts.category);
    where.push(`l.category = $${params.length}`);
  }
  if (opts.analysisStatus) {
    params.push(opts.analysisStatus);
    where.push(`l.analysis_status = $${params.length}`);
  }
  if (opts.needsReview !== undefined) {
    params.push(opts.needsReview);
    where.push(`l.needs_review = $${params.length}`);
  }
  if (opts.search && opts.search.trim() !== "") {
    params.push(`%${opts.search.trim()}%`);
    const p = `$${params.length}`;
    where.push(`(coalesce(l.first_name, '') || ' ' || coalesce(l.last_name, '') ILIKE ${p} OR l.email ILIKE ${p} OR l.phone ILIKE ${p} OR l.address ILIKE ${p})`);
  }
  if (opts.source) {
    params.push(opts.source.toLowerCase());
    where.push(`lower(coalesce(l.source, '')) = $${params.length}`);
  }
  if (opts.projectType) {
    params.push(opts.projectType.toLowerCase());
    where.push(`lower(coalesce(l.project_type, '')) = $${params.length}`);
  }
  if (opts.minScore != null) {
    params.push(opts.minScore);
    where.push(`l.score >= $${params.length}`);
  }
  if (opts.stage) {
    params.push(opts.stage);
    where.push(`l.pipeline_stage = $${params.length}`);
  }
  if (opts.campaignId) {
    params.push(opts.campaignId);
    where.push(`EXISTS (SELECT 1 FROM rescue_campaign_leads cl WHERE cl.organization_id = l.organization_id AND cl.lead_id = l.id AND cl.campaign_id = $${params.length})`);
  }
  if (opts.assignedTo === "none") {
    where.push("l.assigned_user_id IS NULL");
  } else if (opts.assignedTo) {
    params.push(opts.assignedTo);
    where.push(`l.assigned_user_id = $${params.length}`);
  }
  if (opts.restrictToUserId) {
    params.push(opts.restrictToUserId);
    where.push(`l.assigned_user_id = $${params.length}`);
  }
  if (opts.createdFrom) {
    params.push(opts.createdFrom);
    where.push(`l.created_at >= $${params.length}::timestamptz`);
  }
  if (opts.createdTo) {
    params.push(opts.createdTo);
    where.push(`l.created_at < ($${params.length + 1}::timestamptz + interval '1 day')`);
    params.push(opts.createdTo);
  }
  if (opts.suppressed !== undefined) {
    params.push(opts.suppressed);
    where.push(`l.suppressed = $${params.length}`);
  }
  const whereSql = where.join(" AND ");
  const countResult = await getPool().query(`SELECT count(*)::int AS total FROM rescue_leads l WHERE ${whereSql}`, params);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const sortKey: LeadSortKey = opts.sort && (LEAD_SORT_KEYS as readonly string[]).includes(opts.sort) ? opts.sort : "score";
  const dir = opts.dir === "asc" ? "ASC" : "DESC";
  const nulls = dir === "DESC" ? "NULLS LAST" : "NULLS FIRST";
  params.push(limit, offset);
  const { rows } = await getPool().query(
    `SELECT l.id, l.import_id, l.first_name, l.last_name, l.email, l.phone, l.city, l.state, l.project_type, l.estimated_value,
       l.source, l.consent_status, l.suppressed, l.status, l.analysis_status, l.score, l.category, l.needs_review,
       l.analyzed_at, l.created_at, l.pipeline_stage, l.assigned_user_id, l.last_contact_date::text AS last_contact_date,
       u.name AS assigned_name
     FROM rescue_leads l LEFT JOIN users u ON u.id = l.assigned_user_id
     WHERE ${whereSql}
     ORDER BY ${SORT_SQL[sortKey]} ${dir} ${nulls}, l.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return {
    total: countResult.rows[0]?.total ?? 0,
    leads: rows.map((row) => ({
      id: row.id,
      importId: row.import_id,
      firstName: row.first_name,
      lastName: row.last_name,
      email: row.email,
      phone: row.phone,
      city: row.city,
      state: row.state,
      projectType: row.project_type,
      estimatedValue: row.estimated_value != null ? Number(row.estimated_value) : null,
      source: row.source,
      consentStatus: row.consent_status,
      suppressed: row.suppressed,
      status: row.status,
      analysisStatus: row.analysis_status,
      score: row.score,
      category: row.category,
      needsReview: row.needs_review,
      analyzedAt: row.analyzed_at,
      createdAt: row.created_at,
      pipelineStage: row.pipeline_stage,
      assignedUserId: row.assigned_user_id,
      assignedName: row.assigned_name,
      lastContactDate: row.last_contact_date,
    })),
  };
}

/** Distinct filter values for the leads UI (sources, project types). */
export async function getLeadFilterOptions(organizationId: string): Promise<{ sources: string[]; projectTypes: string[] }> {
  const { rows } = await getPool().query(
    `SELECT
       array_remove(array_agg(DISTINCT lower(source)) FILTER (WHERE source IS NOT NULL AND source <> ''), NULL) AS sources,
       array_remove(array_agg(DISTINCT lower(project_type)) FILTER (WHERE project_type IS NOT NULL AND project_type <> ''), NULL) AS project_types
     FROM rescue_leads WHERE organization_id = $1`,
    [organizationId],
  );
  return { sources: rows[0]?.sources ?? [], projectTypes: rows[0]?.project_types ?? [] };
}

export type LeadDetail = LeadForAnalysis & {
  importId: string | null;
  analysisStatus: AnalysisStatus;
  score: number | null;
  category: LeadCategory | null;
  needsReview: boolean;
  analysis: StoredAnalysis | null;
  analysisError: string | null;
  analyzedAt: string | null;
  createdAt: string;
  updatedAt: string;
  pipelineStage: string;
  stageChangedAt: string | null;
  assignedUserId: string | null;
  wonValue: number | null;
};

export async function getLeadDetail(organizationId: string, leadId: string): Promise<LeadDetail | null> {
  const { rows } = await getPool().query(
    `SELECT ${LEAD_FACT_COLUMNS}, import_id, analysis_status, score, category, needs_review,
       analysis, analysis_error, analyzed_at, created_at, updated_at,
       pipeline_stage, stage_changed_at, assigned_user_id, won_value
     FROM rescue_leads WHERE organization_id = $1 AND id = $2`,
    [organizationId, leadId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    ...mapLeadFacts(row),
    importId: row.import_id,
    analysisStatus: row.analysis_status,
    score: row.score,
    category: row.category,
    needsReview: row.needs_review,
    analysis: row.analysis ?? null,
    analysisError: row.analysis_error,
    analyzedAt: row.analyzed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pipelineStage: row.pipeline_stage,
    stageChangedAt: row.stage_changed_at,
    assignedUserId: row.assigned_user_id,
    wonValue: row.won_value != null ? Number(row.won_value) : null,
  };
}

// ---- Message drafts --------------------------------------------------------------

export type MessageDraft = {
  id: string;
  leadId: string;
  createdBy: string | null;
  messageType: MessageType;
  tone: string;
  objective: string | null;
  mode: "ai" | "template";
  content: Record<string, unknown>;
  warnings: string[];
  createdAt: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapDraft(row: any): MessageDraft {
  return {
    id: row.id,
    leadId: row.lead_id,
    createdBy: row.created_by,
    messageType: row.message_type,
    tone: row.tone,
    objective: row.objective,
    mode: row.mode,
    content: row.content ?? {},
    warnings: row.warnings ?? [],
    createdAt: row.created_at,
  };
}

export async function insertMessageDraft(input: {
  organizationId: string;
  leadId: string;
  createdBy: string | null;
  messageType: MessageType;
  tone: string;
  objective: string | null;
  mode: "ai" | "template";
  content: Record<string, unknown>;
  warnings: string[];
}): Promise<MessageDraft> {
  const { rows } = await getPool().query(
    `INSERT INTO lead_message_drafts (organization_id, lead_id, created_by, message_type, tone, objective, mode, content, warnings)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
     RETURNING id, lead_id, created_by, message_type, tone, objective, mode, content, warnings, created_at`,
    [
      input.organizationId,
      input.leadId,
      input.createdBy,
      input.messageType,
      input.tone,
      input.objective,
      input.mode,
      JSON.stringify(input.content),
      JSON.stringify(input.warnings),
    ],
  );
  return mapDraft(rows[0]);
}

export async function listMessageDrafts(organizationId: string, leadId: string, limit = 50): Promise<MessageDraft[]> {
  const { rows } = await getPool().query(
    `SELECT id, lead_id, created_by, message_type, tone, objective, mode, content, warnings, created_at
     FROM lead_message_drafts WHERE organization_id = $1 AND lead_id = $2
     ORDER BY created_at DESC LIMIT $3`,
    [organizationId, leadId, Math.min(limit, 100)],
  );
  return rows.map(mapDraft);
}
