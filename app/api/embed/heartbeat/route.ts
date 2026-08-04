import { NextResponse } from "next/server";
import { embedCorsHeaders, requireEmbedSession } from "@/lib/embed/auth";
import { guardV1 } from "@/lib/public-api/http";
import { recordWidgetHeartbeat } from "@/lib/site-health";
import { isEmbedModule } from "@/lib/embed/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/embed/heartbeat — widget liveness ping from the embed loader.
 * Sent on mount and every few minutes while a page stays open. The org and
 * origin come from the verified embed token (never the request body), so a
 * heartbeat can only ever prove the widget runs where a token was issued for.
 */
export const POST = guardV1(async (request: Request) => {
  const { org, claims } = await requireEmbedSession(request, null);
  const body = (await request.json().catch(() => ({}))) as { module?: unknown };
  // The module is advisory display data — only accept values the token actually allows.
  const widgetModule =
    typeof body.module === "string" && isEmbedModule(body.module) && claims.modules.includes(body.module)
      ? body.module
      : (claims.modules[0] ?? "dashboard");
  await recordWidgetHeartbeat(org.id, claims.origin, widgetModule);
  return NextResponse.json({ data: { ok: true } }, { headers: embedCorsHeaders(claims) });
});

export function OPTIONS(request: Request) {
  const origin = request.headers.get("origin") ?? "*";
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      Vary: "Origin",
    },
  });
}
