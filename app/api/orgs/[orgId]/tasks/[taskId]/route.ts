import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireEntitlement, requireMember } from "@/lib/api-guard";
import { getTaskOwnership, setTaskStatus } from "@/lib/rescue-engage/store";
import { ASSIGNED_ONLY_ROLES, CONVERSATION_WRITE_ROLES } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; taskId: string }> };

/**
 * Complete or dismiss a follow-up task. Assigned-only roles (sales reps) may
 * only touch tasks assigned to them or attached to their assigned leads —
 * enforced server-side, never from client input.
 */
export const PATCH = guard(async (request: Request, { params }: Ctx) => {
  const { orgId, taskId } = await params;
  const { org, role, user } = await requireMember(orgId, CONVERSATION_WRITE_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const body = (await readJson(request)) as { status?: string };
  const status = body.status;
  if (status !== "open" && status !== "done" && status !== "dismissed") {
    throw new ApiError(400, "status must be open, done, or dismissed.");
  }
  const ownership = await getTaskOwnership(org.id, taskId);
  if (!ownership) throw new ApiError(404, "Task not found.");
  if (ASSIGNED_ONLY_ROLES.includes(role) && ownership.assignedUserId !== user.id && ownership.leadAssignedUserId !== user.id) {
    throw new ApiError(403, "This task is not assigned to you.");
  }
  const updated = await setTaskStatus(org.id, taskId, status);
  if (!updated) throw new ApiError(404, "Task not found.");
  return NextResponse.json({ ok: true });
});
