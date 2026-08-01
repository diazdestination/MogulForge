import { NextResponse } from "next/server";
import { ApiError, guard, requireEntitlement, requireMember, requireUser } from "@/lib/api-guard";
import { IMPORT_WRITE_ROLES } from "@/lib/roles";
import { rescueIntakeSchema } from "@/lib/rescue-intake-schema";
import { recordIntake, resolveIntakeOrganization } from "@/lib/rescue-intake";
import { parseUploadedFile, UploadParseError } from "@/lib/rescue-import/parse-upload";
import { autoMapColumns, mappingHasContactField } from "@/lib/rescue-import/mapping";
import { isLeadFieldKey, type LeadFieldKey } from "@/lib/rescue-import/fields";
import { createLeadImport } from "@/lib/rescue-import/store";
import { startImportPipeline } from "@/lib/rescue-import/pipeline";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseMappingField(raw: unknown): Record<string, LeadFieldKey | null> | null {
  if (typeof raw !== "string" || !raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError(400, "Invalid field mapping.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ApiError(400, "Invalid field mapping.");
  const mapping: Record<string, LeadFieldKey | null> = {};
  for (const [column, target] of Object.entries(parsed as Record<string, unknown>)) {
    if (target === null || target === "") mapping[column] = null;
    else if (typeof target === "string" && isLeadFieldKey(target)) mapping[column] = target;
  }
  return mapping;
}

/**
 * Final intake wizard submission (multipart): validated intake JSON + optional
 * lead file + field mapping. Creates or reuses the user's organization, stores
 * the intake, stores the file privately, and kicks off the import pipeline.
 */
export const POST = guard(async (request: Request) => {
  const user = await requireUser();
  const form = await request.formData().catch(() => null);
  if (!form) throw new ApiError(400, "Invalid form submission.");

  let intakeRaw: unknown;
  try {
    intakeRaw = JSON.parse(String(form.get("intake") ?? ""));
  } catch {
    throw new ApiError(400, "Invalid intake payload.");
  }
  const parsed = rescueIntakeSchema.safeParse(intakeRaw);
  if (!parsed.success) {
    throw new ApiError(400, parsed.error.issues[0]?.message ?? "Check the intake form for errors.");
  }
  const intake = parsed.data;

  const file = form.get("file");
  const mapping = parseMappingField(form.get("mapping"));
  let upload: { buffer: Buffer; fileName: string } | null = null;
  let parsedUpload: ReturnType<typeof parseUploadedFile> | null = null;
  if (file instanceof File && file.size > 0) {
    const buffer = Buffer.from(await file.arrayBuffer());
    try {
      parsedUpload = parseUploadedFile(file.name, buffer);
    } catch (error) {
      if (error instanceof UploadParseError) throw new ApiError(400, error.message);
      throw error;
    }
    upload = { buffer, fileName: file.name };
  }

  const { organizationId, created } = await resolveIntakeOrganization(
    user,
    intake.company.name,
    intake.company.industry,
  );
  // Importing a file is gated the same way as the org-scoped import routes:
  // a write-capable role plus the lead_import module. A freshly created
  // self-serve org always passes (owner role + starter entitlements).
  if (upload) {
    await requireMember(organizationId, IMPORT_WRITE_ROLES);
    await requireEntitlement(organizationId, "lead_import");
  }

  const intakeId = await recordIntake(organizationId, user.id, intake);

  let importId: string | null = null;
  let importStatus: string | null = null;
  if (upload && parsedUpload) {
    const autoMapping = autoMapColumns(parsedUpload.headers, parsedUpload.rows.slice(0, 25));
    const effectiveMapping =
      mapping ?? Object.fromEntries(autoMapping.map((column) => [column.sourceColumn, column.target]));
    const ready = mappingHasContactField(effectiveMapping);
    const record = await createLeadImport({
      organizationId,
      createdBy: user.id,
      fileName: upload.fileName,
      fileType: parsedUpload.fileType,
      fileData: upload.buffer,
      sourceLabel: intake.leadSources.sources.join(", ").slice(0, 200),
      rowCount: parsedUpload.rows.length,
      columns: parsedUpload.headers,
      sampleRows: parsedUpload.rows.slice(0, 5),
      autoMapping,
      fieldMapping: effectiveMapping,
      status: ready ? "uploaded" : "mapping_required",
    });
    importId = record.id;
    importStatus = record.status;
    if (ready) await startImportPipeline(organizationId, record.id, user.email);
  }

  await logAudit({
    organizationId,
    actorUserId: user.id,
    actorLabel: user.email,
    action: "rescue_intake.submitted",
    targetType: "rescue_intake",
    targetId: intakeId,
    metadata: { orgCreated: created, hasFile: !!upload, importId },
  });

  return NextResponse.json(
    { organizationId, organizationCreated: created, intakeId, importId, importStatus },
    { status: 201 },
  );
});
