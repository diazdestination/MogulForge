import { NextResponse } from "next/server";
import { ApiError, guard, requireEntitlement, requireMember } from "@/lib/api-guard";
import { logAudit } from "@/lib/audit";
import { getCrmConnection } from "@/lib/crm/store";
import { pullCrmUpdates } from "@/lib/crm/sync";
import { MANAGER_ROLES } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; connectionId: string }> };

/**
 * Inbound sync: pulls recent contacts from the provider and reconciles them
 * with local leads. Disagreements land in crm_sync_conflicts for human review —
 * remote data never silently overwrites newer local data.
 */
export const POST = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId, connectionId } = await params;
  const { org, user } = await requireMember(orgId, MANAGER_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const connection = await getCrmConnection(org.id, connectionId).catch(() => null);
  if (!connection) throw new ApiError(404, "Connection not found.");
  if (connection.status !== "active") throw new ApiError(409, "Activate the connection before pulling updates.");
  if (connection.syncDirection === "outbound") {
    throw new ApiError(409, "This connection is outbound-only. Set its sync direction to inbound or bidirectional first.");
  }

  const summary = await pullCrmUpdates(org.id, connection);
  await logAudit({
    organizationId: org.id,
    actorUserId: user.id,
    actorLabel: user.email,
    action: "crm_sync.pulled",
    targetType: "crm_connection",
    targetId: connection.id,
    metadata: { provider: connection.provider, ...summary },
  });
  return NextResponse.json({ summary });
});
