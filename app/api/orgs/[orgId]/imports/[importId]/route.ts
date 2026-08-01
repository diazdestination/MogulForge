import { NextResponse } from "next/server";
import { ApiError, guard, requireEntitlement, requireMember } from "@/lib/api-guard";
import { getLeadImport } from "@/lib/rescue-import/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; importId: string }> };

/** Import detail + stage log — the dashboard polls this while a pipeline runs. */
export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId, importId } = await params;
  const { org } = await requireMember(orgId);
  await requireEntitlement(org.id, "lead_import");
  const record = await getLeadImport(org.id, importId);
  if (!record) throw new ApiError(404, "Import not found.");
  return NextResponse.json({ import: record });
});
