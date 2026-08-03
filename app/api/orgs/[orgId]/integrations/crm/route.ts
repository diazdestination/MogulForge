import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireEntitlement, requireMember } from "@/lib/api-guard";
import { logAudit } from "@/lib/audit";
import { CRM_PROVIDERS, isConnectableProvider, parseConnectionConfig, redactConnectionConfig } from "@/lib/crm/adapters";
import { createCrmConnection, listCrmConnections, listSyncConflicts } from "@/lib/crm/store";
import { MANAGER_ROLES } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

/** CRM provider catalog (honest statuses), connections, and pending sync conflicts. */
export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org } = await requireMember(orgId, MANAGER_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const [connections, conflicts] = await Promise.all([listCrmConnections(org.id), listSyncConflicts(org.id, { status: "pending" })]);
  // Credentials never reach the browser — secrets are replaced with a placeholder.
  const safeConnections = connections.map((c) => ({ ...c, config: redactConnectionConfig(c.provider, c.config) }));
  return NextResponse.json({ providers: CRM_PROVIDERS, connections: safeConnections, conflicts });
});

/** Creates a CRM connection draft. Only providers marked available can be configured. */
export const POST = guard(async (request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org, user } = await requireMember(orgId, MANAGER_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const body = await readJson(request);
  const provider = typeof body.provider === "string" ? body.provider : "";
  if (!isConnectableProvider(provider)) {
    throw new ApiError(400, "This provider is not connectable yet — its native connector is still in development.");
  }
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";
  if (!name) throw new ApiError(400, "A connection name is required.");
  const { config, error } = parseConnectionConfig(provider, body.config ?? {});
  if (!config) throw new ApiError(400, error ?? "Invalid connection config.");

  const connection = await createCrmConnection(org.id, { provider, name, config, createdBy: user.id });
  await logAudit({
    organizationId: org.id,
    actorUserId: user.id,
    actorLabel: user.email,
    action: "crm_connection.created",
    targetType: "crm_connection",
    targetId: connection.id,
    metadata: { provider, name },
  });
  return NextResponse.json({ connection: { ...connection, config: redactConnectionConfig(connection.provider, connection.config) } }, { status: 201 });
});
