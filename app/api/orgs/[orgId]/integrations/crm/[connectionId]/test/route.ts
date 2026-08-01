import { NextResponse } from "next/server";
import { ApiError, guard, requireEntitlement, requireMember } from "@/lib/api-guard";
import { parseGenericConfig, testGenericConnection } from "@/lib/crm/adapters";
import { getCrmConnection, updateCrmConnection } from "@/lib/crm/store";
import { MANAGER_ROLES } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; connectionId: string }> };

/** Sends a clearly-marked test payload (mapped sample lead) and stores the real result. */
export const POST = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId, connectionId } = await params;
  const { org } = await requireMember(orgId, MANAGER_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const connection = await getCrmConnection(org.id, connectionId).catch(() => null);
  if (!connection) throw new ApiError(404, "Connection not found.");
  const { config, error } = parseGenericConfig(connection.config);
  if (!config) throw new ApiError(400, error ?? "Connection config is incomplete — set a destination URL first.");

  const result = await testGenericConnection(config, connection.fieldMapping);
  const updated = await updateCrmConnection(org.id, connectionId, {
    lastTestResult: { ok: result.ok, statusCode: result.statusCode, message: result.message },
    touchLastTest: true,
    status: connection.status === "active" && !result.ok ? "error" : connection.status === "draft" ? "testing" : undefined,
  });
  return NextResponse.json({ result, connection: updated });
});
