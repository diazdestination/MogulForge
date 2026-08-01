import { requireApiKey } from "@/lib/public-api/auth";
import { guardV1, PublicApiError, readV1Json } from "@/lib/public-api/http";
import {
  createOutgoingEndpoint,
  isOutgoingEventType,
  listOutgoingEndpoints,
  OUTGOING_EVENT_TYPES,
  validateWebhookUrl,
  type OutgoingEventType,
} from "@/lib/webhooks/outgoing";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/webhooks — list outgoing webhook endpoints. Scope: webhooks:read. */
export const GET = guardV1(async (request: Request) => {
  const ctx = await requireApiKey(request, "webhooks:read");
  const endpoints = await listOutgoingEndpoints(ctx.org.id);
  // Secrets are shown in the dashboard only; the API returns metadata.
  const data = endpoints.map((endpoint) => ({ ...endpoint, secret: undefined }));
  return NextResponse.json({ data, event_types: OUTGOING_EVENT_TYPES }, { headers: ctx.rateHeaders });
});

/** POST /api/v1/webhooks — register an outgoing webhook endpoint. Scope: webhooks:write. */
export const POST = guardV1(async (request: Request) => {
  const ctx = await requireApiKey(request, "webhooks:write");
  const body = await readV1Json(request);
  const url = typeof body.url === "string" ? body.url.trim() : "";
  const urlError = validateWebhookUrl(url);
  if (!url || urlError) throw new PublicApiError(422, "invalid_url", urlError ?? "url is required.");
  const rawEvents = Array.isArray(body.event_types) ? body.event_types : Array.isArray(body.eventTypes) ? body.eventTypes : [];
  const eventTypes = rawEvents.filter((e): e is OutgoingEventType => typeof e === "string" && isOutgoingEventType(e));
  if (eventTypes.length === 0) {
    throw new PublicApiError(422, "invalid_event_types", `event_types must include at least one of: ${OUTGOING_EVENT_TYPES.join(", ")}.`);
  }
  const endpoint = await createOutgoingEndpoint(ctx.org.id, {
    url,
    description: typeof body.description === "string" ? body.description.slice(0, 500) : null,
    eventTypes,
  });
  // The signing secret is returned once on creation — store it on your side.
  return NextResponse.json({ data: endpoint }, { status: 201, headers: ctx.rateHeaders });
});
