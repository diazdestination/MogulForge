import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireMember } from "@/lib/api-guard";
import { MANAGER_ROLES } from "@/lib/roles";
import { DomainRequestError, listCustomDomains, requestCustomDomain } from "@/lib/custom-domains";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

/** Custom-domain requests for the organization (DNS instructions included). */
export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org } = await requireMember(orgId);
  const domains = await listCustomDomains(org.id);
  return NextResponse.json({ domains });
});

/** Requests a new custom domain (owners/admins). Verification comes next. */
export const POST = guard(async (request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { user, org } = await requireMember(orgId, MANAGER_ROLES);
  const body = await readJson(request);
  if (typeof body.domain !== "string") throw new ApiError(400, "Provide a domain.");

  let domain;
  try {
    domain = await requestCustomDomain(org.id, body.domain);
  } catch (error) {
    if (error instanceof DomainRequestError) throw new ApiError(error.status, error.message);
    throw error;
  }

  await logAudit({
    organizationId: org.id,
    actorUserId: user.id,
    actorLabel: user.email,
    action: "custom_domain.requested",
    targetType: "custom_domain",
    targetId: domain.id,
    metadata: { domain: domain.domain },
  });
  return NextResponse.json({ domain }, { status: 201 });
});
