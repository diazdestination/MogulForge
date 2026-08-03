import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireEntitlement, requireMember } from "@/lib/api-guard";
import { mergeStoredSecrets, parseConnectionConfig, redactConnectionConfig } from "@/lib/crm/adapters";
import { validateFieldMapping } from "@/lib/crm/mapping";
import { deleteCrmConnection, getCrmConnection, updateCrmConnection } from "@/lib/crm/store";
import { MANAGER_ROLES } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; connectionId: string }> };

/**
 * Updates a CRM connection: name, config, field mapping, sync direction, status.
 * Activation requires a successful test (test-before-activate) — no silent go-live.
 */
export const PATCH = guard(async (request: Request, { params }: Ctx) => {
  const { orgId, connectionId } = await params;
  const { org } = await requireMember(orgId, MANAGER_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const existing = await getCrmConnection(org.id, connectionId).catch(() => null);
  if (!existing) throw new ApiError(404, "Connection not found.");

  const body = await readJson(request);
  const patch: Parameters<typeof updateCrmConnection>[2] = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim().slice(0, 100);
    if (!name) throw new ApiError(400, "Name cannot be empty.");
    patch.name = name;
  }
  if (body.config !== undefined) {
    // Clients may echo back the redaction placeholder to mean "keep the stored secret".
    const merged = mergeStoredSecrets(existing.provider, (body.config ?? {}) as Record<string, unknown>, existing.config);
    const { config, error } = parseConnectionConfig(existing.provider, merged);
    if (!config) throw new ApiError(400, error ?? "Invalid connection config.");
    patch.config = config;
    // Changing the destination invalidates any previous successful test.
    patch.lastTestResult = null;
    if (existing.status === "active") patch.status = "testing";
  }
  if (body.fieldMapping !== undefined) {
    const { mapping, errors } = validateFieldMapping(body.fieldMapping);
    if (errors.length > 0) throw new ApiError(400, `Field mapping has problems: ${errors.join(" ")}`);
    patch.fieldMapping = mapping;
  }
  if (body.syncDirection !== undefined) {
    if (body.syncDirection !== "outbound" && body.syncDirection !== "inbound" && body.syncDirection !== "bidirectional") {
      throw new ApiError(400, "syncDirection must be outbound, inbound, or bidirectional.");
    }
    patch.syncDirection = body.syncDirection;
  }
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "disabled") throw new ApiError(400, "status must be 'active' or 'disabled'.");
    if (body.status === "active") {
      const testOk = existing.lastTestResult && (existing.lastTestResult as { ok?: boolean }).ok === true && patch.lastTestResult !== null;
      if (!testOk) throw new ApiError(409, "Run a successful connection test before activating.");
    }
    patch.status = body.status;
  }
  const connection = await updateCrmConnection(org.id, connectionId, patch);
  if (!connection) throw new ApiError(404, "Connection not found.");
  return NextResponse.json({ connection: { ...connection, config: redactConnectionConfig(connection.provider, connection.config) } });
});

export const DELETE = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId, connectionId } = await params;
  const { org } = await requireMember(orgId, MANAGER_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const deleted = await deleteCrmConnection(org.id, connectionId).catch(() => false);
  if (!deleted) throw new ApiError(404, "Connection not found.");
  return NextResponse.json({ deleted: true });
});
