import { NextResponse } from "next/server";
import { ApiError, guard, requireEntitlement, requireMember } from "@/lib/api-guard";
import { logAudit } from "@/lib/audit";
import { retryPushDelivery } from "@/lib/crm/deliveries";
import { loadLeadFieldsForPush } from "@/lib/crm/sync";
import { MANAGER_ROLES } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; connectionId: string; deliveryId: string }> };

/** Manually re-pushes a failed lead delivery through the connection's provider adapter. */
export const POST = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId, connectionId, deliveryId } = await params;
  const { org, user } = await requireMember(orgId, MANAGER_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const { delivery, error } = await retryPushDelivery(org.id, connectionId, deliveryId, loadLeadFieldsForPush);
  if (!delivery) throw new ApiError(404, error ?? "Delivery not found.");
  await logAudit({
    organizationId: org.id,
    actorUserId: user.id,
    actorLabel: user.email,
    action: "crm_sync.push_retried",
    targetType: "crm_connection",
    targetId: delivery.connectionId,
    metadata: { deliveryId: delivery.id, leadId: delivery.leadId, ok: delivery.status === "succeeded" },
  });
  return NextResponse.json({ delivery, ...(error ? { error } : {}) });
});
