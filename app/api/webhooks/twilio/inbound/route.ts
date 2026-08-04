import { NextResponse } from "next/server";
import { normalizePhone } from "@/lib/rescue-import/normalize";
import { validateTwilioSignature } from "@/lib/rescue-engage/providers";
import { processInboundReply } from "@/lib/rescue-engage/reply-service";
import { findLeadForInboundContact } from "@/lib/rescue-engage/store";
import { requestUrlForSignature, twilioParams } from "../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

function twiml(): NextResponse {
  return new NextResponse(EMPTY_TWIML, { status: 200, headers: { "Content-Type": "text/xml" } });
}

/**
 * Twilio inbound SMS webhook. Matches the sender's phone number to a lead and
 * feeds the reply through the same classification/routing pipeline as manual
 * logging — so STOP replies suppress the contact immediately and automatically,
 * without anyone logging them by hand.
 *
 * Always answers with empty TwiML (no auto-reply); unmatched senders are
 * acknowledged silently so Twilio does not retry forever.
 */
export async function POST(request: Request) {
  if (!process.env.TWILIO_AUTH_TOKEN?.trim()) return new NextResponse(null, { status: 404 });
  const { params, raw } = await twilioParams(request);
  if (!validateTwilioSignature(requestUrlForSignature(request), raw, request.headers.get("x-twilio-signature"))) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 403 });
  }

  const from = normalizePhone(params.From ?? "");
  const body = (params.Body ?? "").trim();
  if (!from || !body) return twiml();

  const match = await findLeadForInboundContact("sms", from);
  if (!match) return twiml(); // Unknown sender — nothing to attribute, acknowledge silently.

  await processInboundReply({
    organizationId: match.organizationId,
    leadId: match.leadId,
    channel: "sms",
    body: body.slice(0, 2000),
    actorUserId: null,
    provider: "twilio",
  });
  return twiml();
}
