import { NextResponse } from "next/server";
import { guard, readJson, ApiError } from "@/lib/api-guard";
import { registerUser } from "@/lib/accounts";
import { createUserSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = guard(async (request: Request) => {
  const body = await readJson(request);
  const result = await registerUser({
    email: String(body.email ?? ""),
    name: String(body.name ?? ""),
    password: String(body.password ?? ""),
  });
  if (!result.ok) throw new ApiError(400, result.error);
  await createUserSession(result.userId);
  return NextResponse.json({ ok: true, userId: result.userId }, { status: 201 });
});
