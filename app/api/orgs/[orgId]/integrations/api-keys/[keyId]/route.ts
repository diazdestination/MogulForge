import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireEntitlement, requireMember } from "@/lib/api-guard";
import { revokeApiKey, rotateApiKey } from "@/lib/public-api/keys";
import { MANAGER_ROLES } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; keyId: string }> };

/** POST { action: "rotate" } — revokes the key and issues a replacement (shown once). */
export const POST = guard(async (request: Request, { params }: Ctx) => {
  const { orgId, keyId } = await params;
  const { org, user } = await requireMember(orgId, MANAGER_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const body = await readJson(request);
  if (body.action !== "rotate") throw new ApiError(400, "Unsupported action.");
  const rotated = await rotateApiKey(org.id, keyId, { userId: user.id, label: user.email }).catch(() => null);
  if (!rotated) throw new ApiError(404, "Key not found or already revoked.");
  return NextResponse.json({ key: rotated.key, rawKey: rotated.rawKey });
});

/** DELETE — revokes the key immediately. */
export const DELETE = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId, keyId } = await params;
  const { org, user } = await requireMember(orgId, MANAGER_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const revoked = await revokeApiKey(org.id, keyId, { userId: user.id, label: user.email }).catch(() => null);
  if (!revoked) throw new ApiError(404, "Key not found or already revoked.");
  return NextResponse.json({ key: revoked });
});
