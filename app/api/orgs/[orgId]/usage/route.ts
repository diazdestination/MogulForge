import { NextResponse } from "next/server";
import { ApiError, guard, requireMember } from "@/lib/api-guard";
import { getUsageStatus } from "@/lib/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

/** Current-period usage, limits, and warnings for the organization. */
export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org } = await requireMember(orgId);
  const status = await getUsageStatus(org.id);
  if (!status) throw new ApiError(404, "Organization not found.");
  return NextResponse.json({ usage: status });
});
