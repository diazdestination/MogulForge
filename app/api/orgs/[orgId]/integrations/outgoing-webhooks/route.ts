import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireEntitlement, requireMember } from "@/lib/api-guard";
import { logAudit } from "@/lib/audit";
import {
  createOutgoingEndpoint,
  isOutgoingEventType,
  listDeliveries,
  listOutgoingEndpoints,
  OUTGOING_EVENT_TYPES,
  validateWebhookUrl,
  type OutgoingEventType,
} from "@/lib/webhooks/outgoing";
import { MANAGER_ROLES } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

/** Outgoing webhook endpoints (with signing secrets for managers) + recent deliveries. */
export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org } = await requireMember(orgId, MANAGER_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const [endpoints, deliveries] = await Promise.all([listOutgoingEndpoints(org.id), listDeliveries(org.id, { limit: 50 })]);
  return NextResponse.json({ endpoints, deliveries, eventTypes: OUTGOING_EVENT_TYPES });
});

/** Registers an outgoing webhook endpoint. */
export const POST = guard(async (request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org, user } = await requireMember(orgId, MANAGER_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const body = await readJson(request);
  const url = typeof body.url === "string" ? body.url.trim() : "";
  const urlError = url ? validateWebhookUrl(url) : "A destination URL is required.";
  if (urlError) throw new ApiError(400, urlError);
  const rawEvents = Array.isArray(body.eventTypes) ? body.eventTypes : [];
  const eventTypes = rawEvents.filter((e): e is OutgoingEventType => typeof e === "string" && isOutgoingEventType(e));
  if (eventTypes.length === 0) throw new ApiError(400, "Select at least one event type.");
  const endpoint = await createOutgoingEndpoint(org.id, {
    url,
    description: typeof body.description === "string" ? body.description.trim().slice(0, 500) || null : null,
    eventTypes,
    createdBy: user.id,
  });
  await logAudit({
    organizationId: org.id,
    actorUserId: user.id,
    actorLabel: user.email,
    action: "webhook_endpoint.created",
    targetType: "webhook_endpoint",
    targetId: endpoint.id,
    metadata: { url, eventTypes },
  });
  return NextResponse.json({ endpoint }, { status: 201 });
});
