import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireEntitlement, requireMember } from "@/lib/api-guard";
import { logAudit } from "@/lib/audit";
import { updateOrganization } from "@/lib/tenant";
import { MANAGER_ROLES } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

/** Approved embed origins for the org. */
export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org } = await requireMember(orgId, MANAGER_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  return NextResponse.json({ allowedOrigins: org.allowedOrigins });
});

/** Replaces the approved origins list (owners/admins). Origins gate embed tokens + CSP. */
export const PATCH = guard(async (request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org, user } = await requireMember(orgId, MANAGER_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const body = await readJson(request);
  if (!Array.isArray(body.allowedOrigins)) throw new ApiError(400, "allowedOrigins must be an array.");
  const cleaned: string[] = [];
  for (const raw of body.allowedOrigins) {
    const value = String(raw).trim();
    if (!value) continue;
    if (value.startsWith("*.")) {
      if (!/^\*\.[a-z0-9.-]+\.[a-z]{2,}$/i.test(value)) throw new ApiError(400, `"${value}" is not a valid wildcard entry (use *.example.com).`);
      cleaned.push(value.toLowerCase());
      continue;
    }
    try {
      const url = new URL(value.includes("://") ? value : `https://${value}`);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("bad protocol");
      cleaned.push(url.origin);
    } catch {
      throw new ApiError(400, `"${value}" is not a valid origin. Use e.g. https://www.example.com`);
    }
  }
  const unique = Array.from(new Set(cleaned)).slice(0, 50);
  const updated = await updateOrganization(org.id, { allowedOrigins: unique });
  await logAudit({
    organizationId: org.id,
    actorUserId: user.id,
    actorLabel: user.email,
    action: "org.allowed_origins_updated",
    targetType: "organization",
    targetId: org.id,
    metadata: { allowedOrigins: unique },
  });
  return NextResponse.json({ allowedOrigins: updated?.allowedOrigins ?? unique });
});
