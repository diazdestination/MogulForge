import { NextResponse } from "next/server";
import { guard, requireMember } from "@/lib/api-guard";
import { listEntitlements } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org } = await requireMember(orgId);
  return NextResponse.json({ entitlements: await listEntitlements(org.id) });
});
