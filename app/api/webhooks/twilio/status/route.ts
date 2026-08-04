import { NextResponse } from "next/server";
import { validateTwilioSignature } from "@/lib/rescue-engage/providers";
import { applyDeliveryStatus, logActivity } from "@/lib/rescue-engage/store";
import { requestUrlForSignature, twilioParams } from "../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Twilio delivery-status callback. Updates the live outbound message the
 * callback belongs to (queued → sent → delivered/failed) — honestly and only
 * for non-simulated rows; the rescue_messages_simulation_honesty constraint
 * guards simulated messages at the DB level.
 *
 * Signature-validated with TWILIO_AUTH_TOKEN. Returns 404 when Twilio is not
 * configured at all so the endpoint reveals nothing.
 */
export async function POST(request: Request) {
  if (!process.env.TWILIO_AUTH_TOKEN?.trim()) return new NextResponse(null, { status: 404 });
  const { params, raw } = await twilioParams(request);
  const url = requestUrlForSignature(request);
  if (!validateTwilioSignature(url, raw, request.headers.get("x-twilio-signature"))) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 403 });
  }

  const sid = params.MessageSid || params.SmsSid;
  const twilioStatus = (params.MessageStatus || params.SmsStatus || "").toLowerCase();
  if (!sid || !twilioStatus) return NextResponse.json({ ok: true, ignored: true });

  const mapped = twilioStatus === "delivered" ? "delivered"
    : twilioStatus === "failed" || twilioStatus === "undelivered" ? "failed"
    : twilioStatus === "sent" ? "sent"
    : null;
  if (!mapped) return NextResponse.json({ ok: true, ignored: true });

  const updated = await applyDeliveryStatus("twilio", sid, mapped);
  if (updated && mapped === "failed") {
    await logActivity({
      organizationId: updated.organizationId,
      leadId: updated.message.leadId,
      campaignId: updated.message.campaignId,
      activityType: "message_delivery_failed",
      title: "SMS delivery failed",
      detail: params.ErrorCode ? `Twilio error code ${params.ErrorCode}` : "Carrier reported the message as undelivered.",
      metadata: { providerMessageId: sid, twilioStatus },
      actorUserId: null,
    });
  }
  return NextResponse.json({ ok: true, updated: !!updated });
}
