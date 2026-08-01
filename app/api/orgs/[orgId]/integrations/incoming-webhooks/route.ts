import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireEntitlement, requireMember } from "@/lib/api-guard";
import { logAudit } from "@/lib/audit";
import { createIncomingEndpoint, INCOMING_EVENT_TYPES, listIncomingEndpoints, listIncomingEvents } from "@/lib/webhooks/incoming";
import { MANAGER_ROLES } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

/** Incoming webhook endpoints + recent events for the integrations page. */
export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org } = await requireMember(orgId, MANAGER_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const [endpoints, events] = await Promise.all([listIncomingEndpoints(org.id), listIncomingEvents(org.id, { limit: 50 })]);
  return NextResponse.json({ endpoints, events, eventTypes: INCOMING_EVENT_TYPES });
});

/** Creates an incoming webhook endpoint (URL token + signing secret). */
export const POST = guard(async (request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org, user } = await requireMember(orgId, MANAGER_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const body = await readJson(request);
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";
  if (!name) throw new ApiError(400, "An endpoint name is required.");
  const endpoint = await createIncomingEndpoint(org.id, { name, createdBy: user.id });
  await logAudit({
    organizationId: org.id,
    actorUserId: user.id,
    actorLabel: user.email,
    action: "incoming_webhook.created",
    targetType: "incoming_webhook_endpoint",
    targetId: endpoint.id,
    metadata: { name },
  });
  return NextResponse.json({ endpoint }, { status: 201 });
});
