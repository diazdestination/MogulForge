import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireEntitlement, requireMember } from "@/lib/api-guard";
import { IMPORT_WRITE_ROLES } from "@/lib/roles";
import { isLeadFieldKey, type LeadFieldKey } from "@/lib/rescue-import/fields";
import { mappingHasContactField } from "@/lib/rescue-import/mapping";
import { getLeadImport, saveFieldMapping } from "@/lib/rescue-import/store";
import { startImportPipeline } from "@/lib/rescue-import/pipeline";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; importId: string }> };

/** Confirms the field mapping for an import and starts the pipeline. */
export const POST = guard(async (request: Request, { params }: Ctx) => {
  const { orgId, importId } = await params;
  const { user, org } = await requireMember(orgId, IMPORT_WRITE_ROLES);
  await requireEntitlement(org.id, "lead_import");

  const record = await getLeadImport(org.id, importId);
  if (!record) throw new ApiError(404, "Import not found.");
  if (!["uploaded", "mapping_required", "failed", "partial"].includes(record.status)) {
    throw new ApiError(409, "This import is already processing or finished.");
  }

  const body = await readJson(request);
  const rawMapping = body.mapping;
  if (!rawMapping || typeof rawMapping !== "object" || Array.isArray(rawMapping)) {
    throw new ApiError(400, "Provide a mapping object.");
  }
  const mapping: Record<string, LeadFieldKey | null> = {};
  const used = new Set<LeadFieldKey>();
  for (const [column, target] of Object.entries(rawMapping as Record<string, unknown>)) {
    if (!record.columns.includes(column)) continue;
    if (target === null || target === "") {
      mapping[column] = null;
    } else if (typeof target === "string" && isLeadFieldKey(target)) {
      if (used.has(target)) throw new ApiError(400, `Two columns are mapped to the same field (${target}). Each field can only be used once.`);
      used.add(target);
      mapping[column] = target;
    }
  }
  if (!mappingHasContactField(mapping)) {
    throw new ApiError(400, "Map at least one contact column — email or phone — so leads can be reached.");
  }

  await saveFieldMapping(org.id, importId, mapping);
  const started = await startImportPipeline(org.id, importId, user.email);
  if (!started) throw new ApiError(409, "This import is already processing or finished.");

  await logAudit({
    organizationId: org.id,
    actorUserId: user.id,
    actorLabel: user.email,
    action: "lead_import.mapping_confirmed",
    targetType: "lead_import",
    targetId: importId,
    metadata: { mappedFields: [...used] },
  });

  return NextResponse.json({ ok: true });
});
