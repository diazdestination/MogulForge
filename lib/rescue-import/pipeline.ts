import "server-only";
import { LEAD_FIELDS, isLeadFieldKey, type LeadFieldKey } from "./fields.ts";
import { mappingHasContactField } from "./mapping.ts";
import { parseUploadedFile, UploadParseError } from "./parse-upload.ts";
import { cleanText, normalizeConsent, normalizeDate, normalizeEmail, normalizeMoney, normalizePhone } from "./normalize.ts";
import {
  addSuppressionRecords,
  appendImportLogEntry,
  claimImportForRun,
  clearImportResults,
  findExistingLeadKeys,
  findSuppressedValues,
  getLeadImport,
  getLeadImportFile,
  insertLeads,
  insertRejectedRows,
  setImportStage,
  type LeadInsert,
  type RejectedRow,
} from "./store.ts";
import { logAudit } from "../audit";
import { getEntitlement } from "../tenant";
import { recordUsageInBackground } from "../usage";
import { startAnalysisRun } from "../rescue-analysis/engine.ts";

/**
 * Staged import pipeline: cleaning → deduplicating → suppression checking →
 * importing → complete/partial/failed. Each stage transition is persisted so
 * the dashboard can show live progress; every write is org-scoped.
 */

type CleanedRow = {
  rowNumber: number; // 1-based data row number (excluding header)
  raw: Record<string, string>;
  lead: Omit<LeadInsert, "importId" | "suppressed" | "suppressionReason">;
};

function sanitizeMapping(raw: Record<string, unknown> | null): Record<string, LeadFieldKey> {
  const mapping: Record<string, LeadFieldKey> = {};
  if (!raw) return mapping;
  const used = new Set<LeadFieldKey>();
  for (const [column, target] of Object.entries(raw)) {
    if (typeof target !== "string" || !isLeadFieldKey(target) || used.has(target)) continue;
    used.add(target);
    mapping[column] = target;
  }
  return mapping;
}

function buildLead(values: Partial<Record<LeadFieldKey, string>>): CleanedRow["lead"] {
  const email = cleanText(values.email, 320);
  const phone = cleanText(values.phone, 40);
  return {
    firstName: cleanText(values.firstName, 100),
    lastName: cleanText(values.lastName, 100),
    email,
    emailNormalized: normalizeEmail(values.email),
    phone,
    phoneNormalized: normalizePhone(values.phone),
    address: cleanText(values.address, 200),
    city: cleanText(values.city, 100),
    state: cleanText(values.state, 50),
    zip: cleanText(values.zip, 20),
    projectType: cleanText(values.projectType, 120),
    projectDescription: cleanText(values.projectDescription, 2000),
    estimatedValue: normalizeMoney(values.estimatedValue),
    source: cleanText(values.source, 120),
    sourceDetail: cleanText(values.sourceDetail, 200),
    externalRecordId: cleanText(values.externalRecordId, 120),
    firstContactDate: normalizeDate(values.firstContactDate),
    lastContactDate: normalizeDate(values.lastContactDate),
    estimateDate: normalizeDate(values.estimateDate),
    consentStatus: normalizeConsent(values.consentStatus),
    notes: cleanText(values.notes, 2000),
  };
}

/**
 * Processes an already-claimed import. Callers must win `claimImportForRun`
 * first (see startImportPipeline) — the claim is what guarantees only one run
 * per import. A re-run first clears the previous run's leads + rejected rows,
 * so retrying a failed or partial import never double-inserts.
 */
async function processClaimedImport(organizationId: string, importId: string, actorLabel: string): Promise<void> {
  try {
    const record = await getLeadImport(organizationId, importId);
    if (!record) throw new Error("Import not found after claim.");
    const mapping = sanitizeMapping(record.fieldMapping);
    if (!mappingHasContactField(mapping)) {
      await setImportStage(organizationId, importId, "mapping_required", "Map at least one contact column (email or phone) to continue.");
      return;
    }

    const fileData = await getLeadImportFile(organizationId, importId);
    if (!fileData) throw new Error("Stored file is missing.");

    // Safe retry: drop any output from a previous run before re-processing.
    await clearImportResults(organizationId, importId);

    // ---- Stage: cleaning ------------------------------------------------
    await setImportStage(organizationId, importId, "cleaning", "Normalizing names, emails, phones, dates, and values.");
    let parsed;
    try {
      parsed = parseUploadedFile(record.fileName, fileData);
    } catch (error) {
      if (error instanceof UploadParseError) {
        await setImportStage(organizationId, importId, "failed", undefined, { error: error.message });
        return;
      }
      throw error;
    }
    const { headers, rows } = parsed;
    const columnIndex = new Map<string, number>();
    headers.forEach((header, idx) => {
      if (!columnIndex.has(header)) columnIndex.set(header, idx);
    });

    const rejected: RejectedRow[] = [];
    const cleaned: CleanedRow[] = [];
    rows.forEach((cells, idx) => {
      const rowNumber = idx + 1;
      const raw: Record<string, string> = {};
      headers.forEach((header, colIdx) => {
        const value = (cells[colIdx] ?? "").toString();
        if (value !== "") raw[header] = value.slice(0, 1000);
      });
      const values: Partial<Record<LeadFieldKey, string>> = {};
      for (const [column, target] of Object.entries(mapping)) {
        const colIdx = columnIndex.get(column);
        if (colIdx === undefined) continue;
        const value = (cells[colIdx] ?? "").toString().trim();
        if (value !== "") values[target] = value;
      }
      const lead = buildLead(values);
      if (!lead.emailNormalized && !lead.phoneNormalized) {
        const hadSomething = values.email || values.phone;
        rejected.push({
          rowNumber,
          rowData: raw,
          reason: hadSomething
            ? "Invalid contact info: email and phone could not be parsed."
            : "No contact info: the row has neither an email nor a phone number.",
        });
        return;
      }
      cleaned.push({ rowNumber, raw, lead });
    });
    const invalidCount = rejected.length;

    // ---- Stage: deduplicating -------------------------------------------
    await setImportStage(organizationId, importId, "deduplicating", "Checking for duplicates in this file and your existing leads.", { invalidCount });
    const seenExternal = new Set<string>();
    const seenEmail = new Set<string>();
    const seenPhone = new Set<string>();
    const afterInFileDedupe: CleanedRow[] = [];
    let duplicateCount = 0;
    for (const row of cleaned) {
      const { externalRecordId, emailNormalized, phoneNormalized } = row.lead;
      let dupOf: string | null = null;
      if (externalRecordId && seenExternal.has(externalRecordId)) dupOf = `external record ID ${externalRecordId}`;
      else if (emailNormalized && seenEmail.has(emailNormalized)) dupOf = `email ${emailNormalized}`;
      else if (phoneNormalized && seenPhone.has(phoneNormalized)) dupOf = `phone ${phoneNormalized}`;
      if (dupOf) {
        duplicateCount++;
        rejected.push({ rowNumber: row.rowNumber, rowData: row.raw, reason: `Duplicate in file: same ${dupOf} as an earlier row.` });
        continue;
      }
      if (externalRecordId) seenExternal.add(externalRecordId);
      if (emailNormalized) seenEmail.add(emailNormalized);
      if (phoneNormalized) seenPhone.add(phoneNormalized);
      afterInFileDedupe.push(row);
    }

    const existing = await findExistingLeadKeys(organizationId, {
      externalIds: [...seenExternal],
      emails: [...seenEmail],
      phones: [...seenPhone],
    });
    const unique: CleanedRow[] = [];
    for (const row of afterInFileDedupe) {
      const { externalRecordId, emailNormalized, phoneNormalized } = row.lead;
      let dupOf: string | null = null;
      if (externalRecordId && existing.externalIds.has(externalRecordId)) dupOf = `external record ID ${externalRecordId}`;
      else if (emailNormalized && existing.emails.has(emailNormalized)) dupOf = `email ${emailNormalized}`;
      else if (phoneNormalized && existing.phones.has(phoneNormalized)) dupOf = `phone ${phoneNormalized}`;
      if (dupOf) {
        duplicateCount++;
        rejected.push({ rowNumber: row.rowNumber, rowData: row.raw, reason: `Already imported: a lead with the same ${dupOf} exists.` });
        continue;
      }
      unique.push(row);
    }

    // ---- Stage: suppression checking -------------------------------------
    await setImportStage(organizationId, importId, "suppression_checking", "Honoring opt-outs and your do-not-contact list.", { duplicateCount });

    // Opt-outs found in the file are added to the suppression list immediately.
    const newSuppressions = unique
      .filter((row) => row.lead.consentStatus === "opted_out")
      .flatMap((row) => {
        const records = [];
        if (row.lead.emailNormalized) records.push({ channel: "email" as const, value: row.lead.emailNormalized, reason: "Opt-out in imported file", source: `import:${record.fileName}` });
        if (row.lead.phoneNormalized) records.push({ channel: "phone" as const, value: row.lead.phoneNormalized, reason: "Opt-out in imported file", source: `import:${record.fileName}` });
        return records;
      });
    await addSuppressionRecords(organizationId, newSuppressions);

    const suppressedValues = await findSuppressedValues(organizationId, {
      emails: unique.map((row) => row.lead.emailNormalized).filter((v): v is string => !!v),
      phones: unique.map((row) => row.lead.phoneNormalized).filter((v): v is string => !!v),
    });

    let suppressedCount = 0;
    const toInsert: LeadInsert[] = unique.map((row) => {
      const optedOut = row.lead.consentStatus === "opted_out";
      const onList =
        (row.lead.emailNormalized && suppressedValues.emails.has(row.lead.emailNormalized)) ||
        (row.lead.phoneNormalized && suppressedValues.phones.has(row.lead.phoneNormalized));
      const suppressed = optedOut || !!onList;
      if (suppressed) suppressedCount++;
      return {
        ...row.lead,
        importId,
        suppressed,
        suppressionReason: suppressed ? (optedOut ? "Opt-out in imported file" : "Matches your do-not-contact list") : null,
      };
    });

    // ---- Stage: importing -------------------------------------------------
    await setImportStage(organizationId, importId, "importing", `Storing ${toInsert.length.toLocaleString()} leads.`, { suppressedCount });
    const importedCount = await insertLeads(organizationId, toInsert);
    if (rejected.length > 0) await insertRejectedRows(organizationId, importId, rejected);
    if (importedCount > 0) recordUsageInBackground(organizationId, "leads_imported", importedCount);

    // Nothing imported is never "complete": all-invalid → failed, otherwise
    // (all duplicates / mix) → partial, so the dashboard makes the outcome clear.
    const finalStatus =
      rows.length > 0 && importedCount === 0
        ? invalidCount === rows.length
          ? "failed"
          : "partial"
        : invalidCount > 0
          ? "partial"
          : "complete";
    const finalError =
      finalStatus === "failed"
        ? "Every row was invalid — check the rejected-rows export for reasons."
        : finalStatus === "partial" && importedCount === 0
          ? "No new leads were imported — every valid row already exists in your lead database."
          : null;
    await setImportStage(
      organizationId,
      importId,
      finalStatus,
      `${importedCount.toLocaleString()} imported · ${duplicateCount.toLocaleString()} duplicates · ${suppressedCount.toLocaleString()} suppressed · ${invalidCount.toLocaleString()} invalid`,
      {
        rowCount: rows.length,
        importedCount,
        duplicateCount,
        suppressedCount,
        invalidCount,
        error: finalError,
      },
    );

    await logAudit({
      organizationId,
      actorLabel,
      action: "lead_import.completed",
      targetType: "lead_import",
      targetId: importId,
      metadata: { status: finalStatus, fileName: record.fileName, rowCount: rows.length, importedCount, duplicateCount, suppressedCount, invalidCount },
    });

    // ---- Hand-off: analyzing ---------------------------------------------
    // Newly imported leads land as analysis_status = 'pending'. When the org
    // has the AI Analysis module, the import flows straight into an analysis
    // run (logged on the import's stage log; progress lives on the run).
    if (importedCount > 0) {
      try {
        const entitlement = await getEntitlement(organizationId, "ai_analysis");
        if (entitlement?.enabled) {
          const result = await startAnalysisRun(organizationId, { importId, actorLabel });
          if (result.started) {
            await appendImportLogEntry(organizationId, importId, "analyzing", `Analyzing ${result.run.totalCount.toLocaleString()} imported lead(s) — scores and categories will appear as the run progresses.`);
          } else if (result.reason === "run_in_progress") {
            await appendImportLogEntry(organizationId, importId, "analyzing", "Another analysis run is in progress; these leads will be picked up by the next run.");
          } else if (result.reason === "usage_blocked") {
            await appendImportLogEntry(organizationId, importId, "analyzing", `Automatic analysis skipped: ${result.message}`);
          }
        }
      } catch (analysisError) {
        // Analysis kickoff must never fail the import itself.
        console.error("Post-import analysis kickoff failed", importId, analysisError);
      }
    }
  } catch (error) {
    console.error("Lead import pipeline failed", importId, error);
    await setImportStage(organizationId, importId, "failed", undefined, {
      error: "Import processing failed unexpectedly. You can retry this import safely.",
    }).catch(() => {});
    await logAudit({
      organizationId,
      actorLabel,
      action: "lead_import.failed",
      targetType: "lead_import",
      targetId: importId,
      metadata: { message: error instanceof Error ? error.message : String(error) },
    });
  }
}

/** Kicks off the pipeline without blocking the response; errors are persisted on the import. */
/**
 * Claims the import and, if the claim wins, fires the pipeline run in the
 * background. Returns false when the import could not be claimed — i.e. a run
 * is already in progress (fresh lease) or the import is complete.
 */
export async function startImportPipeline(organizationId: string, importId: string, actorLabel: string): Promise<boolean> {
  const claimed = await claimImportForRun(organizationId, importId);
  if (!claimed) return false;
  void processClaimedImport(organizationId, importId, actorLabel).catch((error) => {
    console.error("Unhandled pipeline error", importId, error);
  });
  return true;
}

/** Column headers that the rejected-rows export uses, in original file order. */
export function rejectedExportHeaders(columns: string[]): string[] {
  return ["row_number", "reason", ...columns];
}

export const LEAD_FIELD_COUNT = LEAD_FIELDS.length;
