import { NextResponse } from "next/server";
import { ApiError, guard, requireEntitlement, requireMember } from "@/lib/api-guard";
import { retryDelivery } from "@/lib/webhooks/outgoing";
import { MANAGER_ROLES } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; deliveryId: string }> };

/** Manual retry for a failed or exhausted outgoing webhook delivery. */
export const POST = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId, deliveryId } = await params;
  const { org } = await requireMember(orgId, MANAGER_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const delivery = await retryDelivery(org.id, deliveryId).catch(() => null);
  if (!delivery) throw new ApiError(404, "Delivery not found.");
  return NextResponse.json({ delivery });
});
