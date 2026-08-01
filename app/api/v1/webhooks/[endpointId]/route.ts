import { requireApiKey } from "@/lib/public-api/auth";
import { guardV1, PublicApiError, readV1Json } from "@/lib/public-api/http";
import {
  deleteOutgoingEndpoint,
  getOutgoingEndpoint,
  isOutgoingEventType,
  listDeliveries,
  updateOutgoingEndpoint,
  validateWebhookUrl,
  type OutgoingEventType,
} from "@/lib/webhooks/outgoing";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ endpointId: string }> };

/** GET /api/v1/webhooks/:id — endpoint detail + recent deliveries. Scope: webhooks:read. */
export const GET = guardV1(async (request: Request, { params }: Ctx) => {
  const ctx = await requireApiKey(request, "webhooks:read");
  const { endpointId } = await params;
  const endpoint = await getOutgoingEndpoint(ctx.org.id, endpointId).catch(() => null);
  if (!endpoint) throw new PublicApiError(404, "not_found", "Webhook endpoint not found.");
  const deliveries = await listDeliveries(ctx.org.id, { endpointId, limit: 50 });
  return NextResponse.json({ data: { ...endpoint, secret: undefined, deliveries } }, { headers: ctx.rateHeaders });
});

/** PATCH /api/v1/webhooks/:id — update url/events/status. Scope: webhooks:write. */
export const PATCH = guardV1(async (request: Request, { params }: Ctx) => {
  const ctx = await requireApiKey(request, "webhooks:write");
  const { endpointId } = await params;
  const body = await readV1Json(request);
  const patch: Parameters<typeof updateOutgoingEndpoint>[2] = {};
  if (body.url !== undefined) {
    const url = typeof body.url === "string" ? body.url.trim() : "";
    const urlError = validateWebhookUrl(url);
    if (!url || urlError) throw new PublicApiError(422, "invalid_url", urlError ?? "url must be a valid URL.");
    patch.url = url;
  }
  const rawEvents = body.event_types ?? body.eventTypes;
  if (rawEvents !== undefined) {
    const eventTypes = (Array.isArray(rawEvents) ? rawEvents : []).filter(
      (e): e is OutgoingEventType => typeof e === "string" && isOutgoingEventType(e),
    );
    if (eventTypes.length === 0) throw new PublicApiError(422, "invalid_event_types", "event_types must include at least one supported type.");
    patch.eventTypes = eventTypes;
  }
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "disabled") throw new PublicApiError(422, "invalid_status", "status must be 'active' or 'disabled'.");
    patch.status = body.status;
  }
  if (body.description !== undefined) patch.description = body.description === null ? null : String(body.description).slice(0, 500);
  const updated = await updateOutgoingEndpoint(ctx.org.id, endpointId, patch);
  if (!updated) throw new PublicApiError(404, "not_found", "Webhook endpoint not found.");
  return NextResponse.json({ data: { ...updated, secret: undefined } }, { headers: ctx.rateHeaders });
});

/** DELETE /api/v1/webhooks/:id — remove the endpoint. Scope: webhooks:write. */
export const DELETE = guardV1(async (request: Request, { params }: Ctx) => {
  const ctx = await requireApiKey(request, "webhooks:write");
  const { endpointId } = await params;
  const deleted = await deleteOutgoingEndpoint(ctx.org.id, endpointId).catch(() => false);
  if (!deleted) throw new PublicApiError(404, "not_found", "Webhook endpoint not found.");
  return NextResponse.json({ data: { deleted: true } }, { headers: ctx.rateHeaders });
});
