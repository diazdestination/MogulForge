import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireEntitlement, requireMember } from "@/lib/api-guard";
import { deleteIncomingEndpoint, setIncomingEndpointStatus } from "@/lib/webhooks/incoming";
import { MANAGER_ROLES } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; endpointId: string }> };

/** Enable/disable an incoming webhook endpoint. */
export const PATCH = guard(async (request: Request, { params }: Ctx) => {
  const { orgId, endpointId } = await params;
  const { org } = await requireMember(orgId, MANAGER_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const body = await readJson(request);
  if (body.status !== "active" && body.status !== "disabled") throw new ApiError(400, "status must be 'active' or 'disabled'.");
  const endpoint = await setIncomingEndpointStatus(org.id, endpointId, body.status).catch(() => null);
  if (!endpoint) throw new ApiError(404, "Endpoint not found.");
  return NextResponse.json({ endpoint });
});

export const DELETE = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId, endpointId } = await params;
  const { org } = await requireMember(orgId, MANAGER_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const deleted = await deleteIncomingEndpoint(org.id, endpointId).catch(() => false);
  if (!deleted) throw new ApiError(404, "Endpoint not found.");
  return NextResponse.json({ deleted: true });
});
