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

const LEAD_FACT_COLUMNS = `id, first_name, last_name, email, email_normalized, phone, phone_normalized,
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
};

export async function listLeads(
  organizationId: string,
  opts: {
    importId?: string;
    category?: string;
    analysisStatus?: string;
    needsReview?: boolean;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ leads: LeadListItem[]; total: number }> {
  const params: unknown[] = [organizationId];
  const where: string[] = ["organization_id = $1"];
  if (opts.importId) {
    params.push(opts.importId);
    where.push(`import_id = $${params.length}`);
  }
  if (opts.category) {
    params.push(opts.category);
    where.push(`category = $${params.length}`);
  }
  if (opts.analysisStatus) {
    params.push(opts.analysisStatus);
    where.push(`analysis_status = $${params.length}`);
  }
  if (opts.needsReview !== undefined) {
    params.push(opts.needsReview);
    where.push(`needs_review = $${params.length}`);
  }
  const whereSql = where.join(" AND ");
  const countResult = await getPool().query(`SELECT count(*)::int AS total FROM rescue_leads WHERE ${whereSql}`, params);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  params.push(limit, offset);
  const { rows } = await getPool().query(
    `SELECT id, import_id, first_name, last_name, email, phone, city, state, project_type, estimated_value,
       source, consent_status, suppressed, status, analysis_status, score, category, needs_review,
       analyzed_at, created_at
     FROM rescue_leads WHERE ${whereSql}
     ORDER BY score DESC NULLS LAST, created_at DESC
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
    })),
  };
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
};

export async function getLeadDetail(organizationId: string, leadId: string): Promise<LeadDetail | null> {
  const { rows } = await getPool().query(
    `SELECT ${LEAD_FACT_COLUMNS}, import_id, analysis_status, score, category, needs_review,
       analysis, analysis_error, analyzed_at, created_at, updated_at
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
