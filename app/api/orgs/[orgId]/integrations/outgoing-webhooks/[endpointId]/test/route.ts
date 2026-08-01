import { NextResponse } from "next/server";
import { ApiError, guard, requireEntitlement, requireMember } from "@/lib/api-guard";
import { sendTestEvent } from "@/lib/webhooks/outgoing";
import { MANAGER_ROLES } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; endpointId: string }> };

/** Sends a test.ping event and returns the real delivery result. */
export const POST = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId, endpointId } = await params;
  const { org } = await requireMember(orgId, MANAGER_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const delivery = await sendTestEvent(org.id, endpointId).catch(() => null);
  if (!delivery) throw new ApiError(404, "Endpoint not found.");
  return NextResponse.json({ delivery });
});
