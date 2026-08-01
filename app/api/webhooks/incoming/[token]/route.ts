import { getIncomingEndpointByToken, ingestIncomingEvent } from "@/lib/webhooks/incoming";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyWebhookSignature } from "@/lib/webhooks/signature";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string }> };

function errorJson(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

/**
 * Organization-specific incoming webhook receiver. Requests must be signed:
 *   X-RevenueRescue-Timestamp: <unix seconds>
 *   X-RevenueRescue-Signature: v1=<hex HMAC-SHA256 of "timestamp.rawBody">
 * Events are processed idempotently per (endpoint, event id).
 */
export const POST = async (request: Request, { params }: Ctx) => {
  const { token } = await params;
  const endpoint = await getIncomingEndpointByToken(token).catch(() => null);
  // Same response for unknown tokens as for bad signatures — no endpoint enumeration.
  if (!endpoint) return errorJson(401, "invalid_signature", "Signature verification failed.");
  if (endpoint.status !== "active") return errorJson(410, "endpoint_disabled", "This webhook endpoint is disabled.");

  const rawBody = await request.text();
  if (rawBody.length > 512 * 1024) return errorJson(413, "payload_too_large", "Payloads must be under 512KB.");

  const check = verifyWebhookSignature({
    secret: endpoint.secret,
    rawBody,
    signatureHeader: request.headers.get(SIGNATURE_HEADER),
    timestampHeader: request.headers.get(TIMESTAMP_HEADER),
  });
  if (!check.valid) {
    if (check.reason === "timestamp_out_of_tolerance") {
      return errorJson(400, "timestamp_out_of_tolerance", "Timestamp is outside the 5 minute tolerance window (possible replay).");
    }
    if (check.reason === "missing_timestamp" || check.reason === "invalid_timestamp") {
      return errorJson(400, "invalid_timestamp", `Provide a unix-seconds timestamp in the ${TIMESTAMP_HEADER} header.`);
    }
    return errorJson(401, "invalid_signature", "Signature verification failed.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return errorJson(400, "invalid_json", "Request body must be valid JSON.");
  }
  const event = parsed as { id?: unknown; type?: unknown; data?: unknown };
  if (typeof event?.id !== "string" || !event.id.trim() || event.id.length > 255) {
    return errorJson(422, "invalid_event", "Event 'id' is required (string, ≤255 chars) and is used for idempotency.");
  }
  if (typeof event?.type !== "string" || !event.type.trim()) {
    return errorJson(422, "invalid_event", "Event 'type' is required.");
  }
  const data = event.data && typeof event.data === "object" && !Array.isArray(event.data) ? (event.data as Record<string, unknown>) : {};

  const result = await ingestIncomingEvent(endpoint, { id: event.id.trim(), type: event.type.trim(), data });
  if (!result.accepted) return errorJson(422, result.code, result.message);
  return NextResponse.json(
    {
      received: true,
      duplicate: result.duplicate,
      status: result.eventStatus,
      ...(result.result ? { detail: result.result } : {}),
      ...(result.error ? { error: result.error } : {}),
    },
    { status: result.duplicate ? 200 : 202 },
  );
};
