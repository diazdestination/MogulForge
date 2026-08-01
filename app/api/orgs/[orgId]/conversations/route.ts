import { NextResponse } from "next/server";
import { guard, requireEntitlement, requireMember } from "@/lib/api-guard";
import { listConversations, listTasks } from "@/lib/rescue-engage/store";
import { ASSIGNED_ONLY_ROLES } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

/** Conversation inbox (one thread per lead) + open follow-up tasks. Sales reps see assigned leads only. */
export const GET = guard(async (request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org, role, user } = await requireMember(orgId);
  await requireEntitlement(org.id, "revenue_rescue");
  const restricted = ASSIGNED_ONLY_ROLES.includes(role);
  const url = new URL(request.url);
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const [conversations, tasks] = await Promise.all([
    listConversations(org.id, { assignedUserId: restricted ? user.id : undefined, limit: Number.isFinite(limit) ? limit : 50 }),
    listTasks(org.id, { assignedUserId: restricted ? user.id : undefined, status: "open", limit: 50 }),
  ]);
  return NextResponse.json({ conversations, tasks, scopedToAssigned: restricted });
});
