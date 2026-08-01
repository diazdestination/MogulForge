import { NextResponse } from "next/server";
import { guard, readJson, ApiError } from "@/lib/api-guard";
import { checkPassword, createAdminSession, destroyAdminSession } from "@/lib/admin-auth";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Programmatic platform-admin login with the ADMIN_PASSWORD (legacy admin folded into platform-admin). */
export const POST = guard(async (request: Request) => {
  const body = await readJson(request);
  if (!checkPassword(String(body.password ?? ""))) throw new ApiError(401, "Invalid admin password.");
  await createAdminSession();
  await logAudit({ actorLabel: "platform-admin (password)", action: "admin.login" });
  return NextResponse.json({ ok: true });
});

export const DELETE = guard(async () => {
  await destroyAdminSession();
  return NextResponse.json({ ok: true });
});
