import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireMember } from "@/lib/api-guard";
import { MANAGER_ROLES } from "@/lib/roles";
import { getCustomDomain, removeCustomDomain, verifyCustomDomain } from "@/lib/custom-domains";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; domainId: string }> };

/** One domain record with its required DNS entries. */
export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId, domainId } = await params;
  const { org } = await requireMember(orgId);
  const domain = await getCustomDomain(org.id, domainId);
  if (!domain || domain.status === "removed") throw new ApiError(404, "Domain not found.");
  return NextResponse.json({ domain });
});

/**
 * POST { action: "verify" } — re-checks the DNS TXT record. Clients can retry
 * as often as they like; failures are recorded, never fatal. (Activation and
 * force-verify are admin-only, on the admin org page.)
 */
export const POST = guard(async (request: Request, { params }: Ctx) => {
  const { orgId, domainId } = await params;
  const { user, org } = await requireMember(orgId, MANAGER_ROLES);
  const body = await readJson(request);
  if (body.action !== "verify") throw new ApiError(400, "Unsupported action. Use { action: \"verify\" }.");

  const result = await verifyCustomDomain(org.id, domainId);
  if (!result) throw new ApiError(404, "Domain not found.");
  if (result.verified) {
    await logAudit({
      organizationId: org.id,
      actorUserId: user.id,
      actorLabel: user.email,
      action: "custom_domain.verified",
      targetType: "custom_domain",
      targetId: domainId,
      metadata: { domain: result.domain.domain },
    });
  }
  return NextResponse.json({ verified: result.verified, error: result.error, domain: result.domain });
});

/** Removes a domain request (frees the domain). */
export const DELETE = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId, domainId } = await params;
  const { user, org } = await requireMember(orgId, MANAGER_ROLES);
  const removed = await removeCustomDomain(org.id, domainId);
  if (!removed) throw new ApiError(404, "Domain not found.");
  await logAudit({
    organizationId: org.id,
    actorUserId: user.id,
    actorLabel: user.email,
    action: "custom_domain.removed",
    targetType: "custom_domain",
    targetId: domainId,
  });
  return NextResponse.json({ ok: true });
});
