import { NextResponse } from "next/server";
import { ApiError, guard, requireEntitlement, requireMember } from "@/lib/api-guard";
import { IMPORT_WRITE_ROLES } from "@/lib/roles";
import { parseUploadedFile, UploadParseError } from "@/lib/rescue-import/parse-upload";
import { autoMapColumns } from "@/lib/rescue-import/mapping";
import { createLeadImport, listLeadImports } from "@/lib/rescue-import/store";
import { logAudit } from "@/lib/audit";
import { requireActionCapacity } from "@/lib/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

/** Import history for the organization (never includes raw file bytes). */
export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org } = await requireMember(orgId);
  await requireEntitlement(org.id, "lead_import");
  const imports = await listLeadImports(org.id);
  return NextResponse.json({ imports });
});

/**
 * Uploads a new lead file (multipart). The file is stored privately, parsed,
 * auto-mapped, and left in `mapping_required` until the mapping is confirmed.
 */
export const POST = guard(async (request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { user, org } = await requireMember(orgId, IMPORT_WRITE_ROLES);
  await requireEntitlement(org.id, "lead_import");

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) throw new ApiError(400, "Attach a lead file to import.");
  const sourceLabel = String(form?.get("sourceLabel") ?? "").trim().slice(0, 200) || null;

  const buffer = Buffer.from(await file.arrayBuffer());
  let parsed;
  try {
    parsed = parseUploadedFile(file.name, buffer);
  } catch (error) {
    if (error instanceof UploadParseError) throw new ApiError(400, error.message);
    throw error;
  }

  // Usage gate: importing this many rows must fit within the plan's import and
  // stored-lead limits. (Suppression/opt-out processing is never gated.)
  await requireActionCapacity(org.id, { leads_imported: parsed.rows.length, leads_stored: parsed.rows.length });

  const autoMapping = autoMapColumns(parsed.headers, parsed.rows.slice(0, 25));
  const record = await createLeadImport({
    organizationId: org.id,
    createdBy: user.id,
    fileName: file.name,
    fileType: parsed.fileType,
    fileData: buffer,
    sourceLabel,
    rowCount: parsed.rows.length,
    columns: parsed.headers,
    sampleRows: parsed.rows.slice(0, 5),
    autoMapping,
    status: "mapping_required",
  });

  await logAudit({
    organizationId: org.id,
    actorUserId: user.id,
    actorLabel: user.email,
    action: "lead_import.uploaded",
    targetType: "lead_import",
    targetId: record.id,
    metadata: { fileName: file.name, fileType: parsed.fileType, rowCount: parsed.rows.length },
  });

  return NextResponse.json({ import: record }, { status: 201 });
});
