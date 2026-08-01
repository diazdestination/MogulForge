import { NextResponse } from "next/server";
import { guard } from "@/lib/api-guard";
import { destroyUserSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = guard(async () => {
  await destroyUserSession();
  return NextResponse.json({ ok: true });
});
