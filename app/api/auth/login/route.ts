import { NextResponse } from "next/server";
import { guard, readJson, ApiError } from "@/lib/api-guard";
import { authenticateUser } from "@/lib/accounts";
import { createUserSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = guard(async (request: Request) => {
  const body = await readJson(request);
  const result = await authenticateUser(String(body.email ?? ""), String(body.password ?? ""));
  if (!result.ok) throw new ApiError(401, result.error);
  await createUserSession(result.userId);
  return NextResponse.json({ ok: true, userId: result.userId });
});
