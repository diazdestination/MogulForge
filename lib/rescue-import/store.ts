import "server-only";
import { getPool } from "../db";
import type { LeadFieldKey } from "./fields.ts";
import type { ColumnMapping } from "./mapping.ts";

/**
 * Tenant-scoped data layer for the lead import pipeline. Every read/write takes
 * an organizationId and scopes the SQL by it. Raw file bytes (file_data) are
 * only reachable through these org-scoped queries — never served publicly.
 */

export const IMPORT_STATUSES = [
  "uploaded", "validating", "mapping_required", "cleaning", "deduplicating",
  "suppression_checking", "importing", "complete", "failed", "partial",
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/** Terminal/idle statuses from which a user may start a (re)run. */
export const RETRYABLE_STATUSES: ImportStatus[] = ["mapping_required", "failed", "partial"];

/** Statuses that mean a pipeline run is (or was) actively processing. */
export const PROCESSING_STATUSES: ImportStatus[] = [
  "validating", "cleaning", "deduplicating", "suppression_checking", "importing",
];

/** How long a run may go without a stage update before its lease is considered
 * stale (e.g. the server restarted mid-run) and the import can be reclaimed. */
export const STALE_RUN_MINUTES = 10;

export type StageLogEntry = { stage: string; at: string; detail?: string };

export type LeadImport = {
  id: string;
  organizationId: string;
  createdBy: string | null;
  fileName: string;
  fileType: string;
  fileSize: number;
  sourceLabel: string | null;
  status: ImportStatus;
  rowCount: number;
  importedCount: number;
  duplicateCount: number;
  suppressedCount: number;
  invalidCount: number;
  columns: string[];
  sampleRows: string[][];
  autoMapping: ColumnMapping[];
  fieldMapping: Record<string, LeadFieldKey | null> | null;
  stageLog: StageLogEntry[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

const IMPORT_COLUMNS = `id, organization_id, created_by, file_name, file_type, file_size, source_label, status,
  row_count, imported_count, duplicate_count, suppressed_count, invalid_count,
  columns, sample_rows, auto_mapping, field_mapping, stage_log, error, created_at, updated_at`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapImport(row: any): LeadImport {
  return {
    id: row.id,
    organizationId: row.organization_id,
    createdBy: row.created_by,
    fileName: row.file_name,
    fileType: row.file_type,
    fileSize: row.file_size,
    sourceLabel: row.source_label,
    status: row.status,
    rowCount: row.row_count,
    importedCount: row.imported_count,
    duplicateCount: row.duplicate_count,
    suppressedCount: row.suppressed_count,
    invalidCount: row.invalid_count,
    columns: row.columns ?? [],
    sampleRows: row.sample_rows ?? [],
    autoMapping: row.auto_mapping ?? [],
    fieldMapping: row.field_mapping ?? null,
    stageLog: row.stage_log ?? [],
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createLeadImport(input: {
  organizationId: string;
  createdBy: string | null;
  fileName: string;
  fileType: string;
  fileData: Buffer;
  sourceLabel?: string | null;
  rowCount: number;
  columns: string[];
  sampleRows: string[][];
  autoMapping: ColumnMapping[];
  fieldMapping?: Record<string, LeadFieldKey | null> | null;
  status: ImportStatus;
}): Promise<LeadImport> {
  const { rows } = await getPool().query(
    `INSERT INTO lead_imports (organization_id, created_by, file_name, file_type, file_size, file_data, source_label,
       status, row_count, columns, sample_rows, auto_mapping, field_mapping, stage_log)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING ${IMPORT_COLUMNS}`,
    [
      input.organizationId,
      input.createdBy,
      input.fileName.slice(0, 200),
      input.fileType,
      input.fileData.length,
      input.fileData,
      input.sourceLabel ?? null,
      input.status,
      input.rowCount,
      JSON.stringify(input.columns),
      JSON.stringify(input.sampleRows),
      JSON.stringify(input.autoMapping),
      input.fieldMapping ? JSON.stringify(input.fieldMapping) : null,
      JSON.stringify([{ stage: "uploaded", at: new Date().toISOString(), detail: `${input.rowCount} data rows detected` }]),
    ],
  );
  return mapImport(rows[0]);
}

export async function getLeadImport(organizationId: string, importId: string): Promise<LeadImport | null> {
  const { rows } = await getPool().query(
    `SELECT ${IMPORT_COLUMNS} FROM lead_imports WHERE organization_id = $1 AND id = $2`,
    [organizationId, importId],
  );
  return rows[0] ? mapImport(rows[0]) : null;
}

export async function getLeadImportFile(organizationId: string, importId: string): Promise<Buffer | null> {
  const { rows } = await getPool().query(
    "SELECT file_data FROM lead_imports WHERE organization_id = $1 AND id = $2",
    [organizationId, importId],
  );
  return rows[0]?.file_data ?? null;
}

export async function listLeadImports(organizationId: string, limit = 50): Promise<LeadImport[]> {
  const { rows } = await getPool().query(
    `SELECT ${IMPORT_COLUMNS} FROM lead_imports WHERE organization_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [organizationId, Math.min(limit, 200)],
  );
  return rows.map(mapImport);
}

export async function saveFieldMapping(
  organizationId: string,
  importId: string,
  mapping: Record<string, LeadFieldKey | null>,
): Promise<void> {
  await getPool().query(
    "UPDATE lead_imports SET field_mapping = $3, updated_at = now() WHERE organization_id = $1 AND id = $2",
    [organizationId, importId, JSON.stringify(mapping)],
  );
}

/** Appends a stage-log entry and moves the import to the given status. */
export async function setImportStage(
  organizationId: string,
  importId: string,
  status: ImportStatus,
  detail?: string,
  counts?: Partial<{ rowCount: number; importedCount: number; duplicateCount: number; suppressedCount: number; invalidCount: number; error: string | null }>,
): Promise<void> {
  const entry: StageLogEntry = { stage: status, at: new Date().toISOString(), ...(detail ? { detail } : {}) };
  const sets: string[] = ["status = $3", "stage_log = stage_log || $4::jsonb", "updated_at = now()"];
  const params: unknown[] = [organizationId, importId, status, JSON.stringify([entry])];
  const columnFor: Record<string, string> = {
    rowCount: "row_count",
    importedCount: "imported_count",
    duplicateCount: "duplicate_count",
    suppressedCount: "suppressed_count",
    invalidCount: "invalid_count",
    error: "error",
  };
  for (const [key, column] of Object.entries(columnFor)) {
    const value = counts?.[key as keyof typeof counts];
    if (value !== undefined) {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    }
  }
  await getPool().query(
    `UPDATE lead_imports SET ${sets.join(", ")} WHERE organization_id = $1 AND id = $2`,
    params,
  );
}

/** Appends a stage-log entry WITHOUT changing the import's status (e.g. the
 * post-import "analyzing" hand-off to the analysis engine). */
export async function appendImportLogEntry(organizationId: string, importId: string, stage: string, detail?: string): Promise<void> {
  const entry: StageLogEntry = { stage, at: new Date().toISOString(), ...(detail ? { detail } : {}) };
  await getPool().query(
    "UPDATE lead_imports SET stage_log = stage_log || $3::jsonb, updated_at = now() WHERE organization_id = $1 AND id = $2",
    [organizationId, importId, JSON.stringify([entry])],
  );
}

/**
 * Atomically claims an import for a pipeline run: only succeeds when the import
 * is currently in a startable status, so two concurrent runs cannot double-import.
 */
/**
 * Atomically claims an import for a pipeline run (lease-style lock). Only one
 * concurrent run can win: imports already in a processing status are NOT
 * claimable unless their last stage update is older than STALE_RUN_MINUTES
 * (an orphaned run, e.g. after a server restart mid-pipeline).
 */
export async function claimImportForRun(organizationId: string, importId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE lead_imports SET status = 'validating', error = NULL,
       stage_log = stage_log || $3::jsonb, updated_at = now()
     WHERE organization_id = $1 AND id = $2
       AND (status = ANY($4)
            OR (status = ANY($5) AND updated_at < now() - make_interval(mins => $6)))`,
    [
      organizationId,
      importId,
      JSON.stringify([{ stage: "validating", at: new Date().toISOString() }]),
      ["uploaded", ...RETRYABLE_STATUSES],
      PROCESSING_STATUSES,
      STALE_RUN_MINUTES,
    ],
  );
  return (rowCount ?? 0) > 0;
}

/** Removes a previous run's output so a retry starts from a clean slate. */
export async function clearImportResults(organizationId: string, importId: string): Promise<void> {
  const pool = getPool();
  await pool.query("DELETE FROM rescue_leads WHERE organization_id = $1 AND import_id = $2", [organizationId, importId]);
  await pool.query("DELETE FROM import_rejected_rows WHERE organization_id = $1 AND import_id = $2", [organizationId, importId]);
  await pool.query(
    `UPDATE lead_imports SET imported_count = 0, duplicate_count = 0, suppressed_count = 0, invalid_count = 0, updated_at = now()
     WHERE organization_id = $1 AND id = $2`,
    [organizationId, importId],
  );
}

export type RejectedRow = { rowNumber: number; rowData: Record<string, string>; reason: string };

export async function insertRejectedRows(organizationId: string, importId: string, rows: RejectedRow[]): Promise<void> {
  const pool = getPool();
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const values: string[] = [];
    const params: unknown[] = [organizationId, importId];
    batch.forEach((row) => {
      params.push(row.rowNumber, JSON.stringify(row.rowData), row.reason.slice(0, 300));
      values.push(`($1, $2, $${params.length - 2}, $${params.length - 1}::jsonb, $${params.length})`);
    });
    await pool.query(
      `INSERT INTO import_rejected_rows (organization_id, import_id, row_number, row_data, reason) VALUES ${values.join(", ")}`,
      params,
    );
  }
}

export async function listRejectedRows(organizationId: string, importId: string): Promise<RejectedRow[]> {
  const { rows } = await getPool().query(
    `SELECT row_number, row_data, reason FROM import_rejected_rows
     WHERE organization_id = $1 AND import_id = $2 ORDER BY row_number ASC LIMIT 20000`,
    [organizationId, importId],
  );
  return rows.map((row) => ({ rowNumber: row.row_number, rowData: row.row_data ?? {}, reason: row.reason }));
}

export type LeadInsert = {
  importId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  emailNormalized: string | null;
  phone: string | null;
  phoneNormalized: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  projectType: string | null;
  projectDescription: string | null;
  estimatedValue: number | null;
  source: string | null;
  sourceDetail: string | null;
  externalRecordId: string | null;
  firstContactDate: string | null;
  lastContactDate: string | null;
  estimateDate: string | null;
  consentStatus: "unknown" | "express" | "implied" | "opted_out";
  suppressed: boolean;
  suppressionReason: string | null;
  notes: string | null;
};

export async function insertLeads(organizationId: string, leads: LeadInsert[]): Promise<number> {
  const pool = getPool();
  let inserted = 0;
  const fields = [
    "import_id", "first_name", "last_name", "email", "email_normalized", "phone", "phone_normalized",
    "address", "city", "state", "zip", "project_type", "project_description", "estimated_value",
    "source", "source_detail", "external_record_id", "first_contact_date", "last_contact_date",
    "estimate_date", "consent_status", "suppressed", "suppression_reason", "notes",
  ];
  for (let i = 0; i < leads.length; i += 250) {
    const batch = leads.slice(i, i + 250);
    const values: string[] = [];
    const params: unknown[] = [organizationId];
    for (const lead of batch) {
      const rowParams = [
        lead.importId, lead.firstName, lead.lastName, lead.email, lead.emailNormalized, lead.phone,
        lead.phoneNormalized, lead.address, lead.city, lead.state, lead.zip, lead.projectType,
        lead.projectDescription, lead.estimatedValue, lead.source, lead.sourceDetail, lead.externalRecordId,
        lead.firstContactDate, lead.lastContactDate, lead.estimateDate, lead.consentStatus,
        lead.suppressed, lead.suppressionReason, lead.notes,
      ];
      const placeholders = rowParams.map((value) => {
        params.push(value);
        return `$${params.length}`;
      });
      values.push(`($1, ${placeholders.join(", ")})`);
    }
    const result = await pool.query(
      `INSERT INTO rescue_leads (organization_id, ${fields.join(", ")}) VALUES ${values.join(", ")}`,
      params,
    );
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}

/** Existing org-level dedupe keys among the given candidate values. */
export async function findExistingLeadKeys(
  organizationId: string,
  candidates: { externalIds: string[]; emails: string[]; phones: string[] },
): Promise<{ externalIds: Set<string>; emails: Set<string>; phones: Set<string> }> {
  const pool = getPool();
  const result = { externalIds: new Set<string>(), emails: new Set<string>(), phones: new Set<string>() };
  if (candidates.externalIds.length > 0) {
    const { rows } = await pool.query(
      "SELECT DISTINCT external_record_id AS v FROM rescue_leads WHERE organization_id = $1 AND external_record_id = ANY($2)",
      [organizationId, candidates.externalIds],
    );
    rows.forEach((row) => result.externalIds.add(row.v));
  }
  if (candidates.emails.length > 0) {
    const { rows } = await pool.query(
      "SELECT DISTINCT email_normalized AS v FROM rescue_leads WHERE organization_id = $1 AND email_normalized = ANY($2)",
      [organizationId, candidates.emails],
    );
    rows.forEach((row) => result.emails.add(row.v));
  }
  if (candidates.phones.length > 0) {
    const { rows } = await pool.query(
      "SELECT DISTINCT phone_normalized AS v FROM rescue_leads WHERE organization_id = $1 AND phone_normalized = ANY($2)",
      [organizationId, candidates.phones],
    );
    rows.forEach((row) => result.phones.add(row.v));
  }
  return result;
}

/** Suppressed values (org do-not-contact list) among the given candidates. */
export async function findSuppressedValues(
  organizationId: string,
  candidates: { emails: string[]; phones: string[] },
): Promise<{ emails: Set<string>; phones: Set<string> }> {
  const pool = getPool();
  const result = { emails: new Set<string>(), phones: new Set<string>() };
  if (candidates.emails.length > 0) {
    const { rows } = await pool.query(
      "SELECT value FROM suppression_records WHERE organization_id = $1 AND channel = 'email' AND value = ANY($2)",
      [organizationId, candidates.emails],
    );
    rows.forEach((row) => result.emails.add(row.value));
  }
  if (candidates.phones.length > 0) {
    const { rows } = await pool.query(
      "SELECT value FROM suppression_records WHERE organization_id = $1 AND channel = 'phone' AND value = ANY($2)",
      [organizationId, candidates.phones],
    );
    rows.forEach((row) => result.phones.add(row.value));
  }
  return result;
}

export type SuppressionInsert = { channel: "email" | "phone"; value: string; reason: string; source: string };

export async function addSuppressionRecords(organizationId: string, records: SuppressionInsert[]): Promise<void> {
  if (records.length === 0) return;
  const pool = getPool();
  for (let i = 0; i < records.length; i += 500) {
    const batch = records.slice(i, i + 500);
    const values: string[] = [];
    const params: unknown[] = [organizationId];
    for (const record of batch) {
      params.push(record.channel, record.value, record.reason.slice(0, 200), record.source.slice(0, 200));
      values.push(`($1, $${params.length - 3}, $${params.length - 2}, $${params.length - 1}, $${params.length})`);
    }
    await pool.query(
      `INSERT INTO suppression_records (organization_id, channel, value, reason, source)
       VALUES ${values.join(", ")} ON CONFLICT (organization_id, channel, value) DO NOTHING`,
      params,
    );
  }
}
