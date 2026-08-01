import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireEntitlement, requireMember } from "@/lib/api-guard";
import { logAudit } from "@/lib/audit";
import { createApiKey, listApiKeys } from "@/lib/public-api/keys";
import { API_SCOPES, isApiScope, type ApiScope } from "@/lib/public-api/scopes";
import { MANAGER_ROLES } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

/** API key list for the integrations page (prefixes only — full keys are never stored). */
export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org } = await requireMember(orgId, MANAGER_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const keys = await listApiKeys(org.id);
  return NextResponse.json({ keys, scopes: API_SCOPES });
});

/** Creates a scoped API key. The full key is returned exactly once. */
export const POST = guard(async (request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org, user } = await requireMember(orgId, MANAGER_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const body = await readJson(request);
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";
  if (!name) throw new ApiError(400, "A key name is required.");
  const rawScopes = Array.isArray(body.scopes) ? body.scopes : [];
  const scopes = rawScopes.filter((s): s is ApiScope => typeof s === "string" && isApiScope(s));
  if (scopes.length === 0) throw new ApiError(400, "Select at least one scope.");

  const { key, rawKey } = await createApiKey(org.id, { name, scopes, createdBy: user.id });
  await logAudit({
    organizationId: org.id,
    actorUserId: user.id,
    actorLabel: user.email,
    action: "api_key.created",
    targetType: "api_key",
    targetId: key.id,
    metadata: { name, scopes },
  });
  return NextResponse.json({ key, rawKey }, { status: 201 });
});
