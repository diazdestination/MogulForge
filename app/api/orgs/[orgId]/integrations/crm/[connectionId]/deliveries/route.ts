import { NextResponse } from "next/server";
import { ApiError, guard, requireEntitlement, requireMember } from "@/lib/api-guard";
import { listPushDeliveries } from "@/lib/crm/deliveries";
import { getCrmConnection } from "@/lib/crm/store";
import { MANAGER_ROLES } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; connectionId: string }> };

/** Recent CRM push deliveries (successes and failures) for one connection. */
export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId, connectionId } = await params;
  const { org } = await requireMember(orgId, MANAGER_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const connection = await getCrmConnection(org.id, connectionId).catch(() => null);
  if (!connection) throw new ApiError(404, "Connection not found.");
  const deliveries = await listPushDeliveries(org.id, connectionId, { limit: 50 });
  return NextResponse.json({ deliveries });
});
