import { requireApiKey } from "@/lib/public-api/auth";
import { guardV1, PublicApiError } from "@/lib/public-api/http";
import { sendTestEvent } from "@/lib/webhooks/outgoing";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ endpointId: string }> };

/** POST /api/v1/webhooks/:id/test — send a test.ping event now. Scope: webhooks:write. */
export const POST = guardV1(async (request: Request, { params }: Ctx) => {
  const ctx = await requireApiKey(request, "webhooks:write");
  const { endpointId } = await params;
  const delivery = await sendTestEvent(ctx.org.id, endpointId).catch(() => null);
  if (!delivery) throw new PublicApiError(404, "not_found", "Webhook endpoint not found.");
  return NextResponse.json({ data: delivery }, { headers: ctx.rateHeaders });
});
