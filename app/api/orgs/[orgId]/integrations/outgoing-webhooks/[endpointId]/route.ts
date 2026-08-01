import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireEntitlement, requireMember } from "@/lib/api-guard";
import {
  deleteOutgoingEndpoint,
  isOutgoingEventType,
  updateOutgoingEndpoint,
  validateWebhookUrl,
  type OutgoingEventType,
} from "@/lib/webhooks/outgoing";
import { MANAGER_ROLES } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; endpointId: string }> };

/** Update url/events/status (disable control) for an outgoing webhook endpoint. */
export const PATCH = guard(async (request: Request, { params }: Ctx) => {
  const { orgId, endpointId } = await params;
  const { org } = await requireMember(orgId, MANAGER_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const body = await readJson(request);
  const patch: Parameters<typeof updateOutgoingEndpoint>[2] = {};
  if (body.url !== undefined) {
    const url = typeof body.url === "string" ? body.url.trim() : "";
    const urlError = url ? validateWebhookUrl(url) : "URL is required.";
    if (urlError) throw new ApiError(400, urlError);
    patch.url = url;
  }
  if (body.eventTypes !== undefined) {
    const eventTypes = (Array.isArray(body.eventTypes) ? body.eventTypes : []).filter(
      (e): e is OutgoingEventType => typeof e === "string" && isOutgoingEventType(e),
    );
    if (eventTypes.length === 0) throw new ApiError(400, "Select at least one event type.");
    patch.eventTypes = eventTypes;
  }
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "disabled") throw new ApiError(400, "status must be 'active' or 'disabled'.");
    patch.status = body.status;
  }
  if (body.description !== undefined) patch.description = body.description === null ? null : String(body.description).slice(0, 500);
  const endpoint = await updateOutgoingEndpoint(org.id, endpointId, patch).catch(() => null);
  if (!endpoint) throw new ApiError(404, "Endpoint not found.");
  return NextResponse.json({ endpoint });
});

export const DELETE = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId, endpointId } = await params;
  const { org } = await requireMember(orgId, MANAGER_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const deleted = await deleteOutgoingEndpoint(org.id, endpointId).catch(() => false);
  if (!deleted) throw new ApiError(404, "Endpoint not found.");
  return NextResponse.json({ deleted: true });
});
