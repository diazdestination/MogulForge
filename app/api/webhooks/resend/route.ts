import { NextResponse } from "next/server";
import { normalizeEmail } from "@/lib/rescue-import/normalize";
import { validateResendSignature } from "@/lib/rescue-engage/providers";
import { processInboundReply } from "@/lib/rescue-engage/reply-service";
import { applyDeliveryStatus, findLeadForInboundContact, logActivity } from "@/lib/rescue-engage/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Resend webhook for outreach email:
 * - delivery events (email.delivered / email.bounced / email.failed /
 *   email.complained) update the matching live outbound rescue_message —
 *   simulated rows are structurally untouchable (provider + honesty constraint);
 * - inbound events (email.received / inbound.email.received) attribute the
 *   reply to a lead by sender address and run the classification/routing
 *   pipeline, so opt-out replies suppress the contact automatically.
 *
 * Signature-verified with RESEND_WEBHOOK_SECRET (Svix scheme). Returns 404
 * while no secret is configured so the endpoint reveals nothing.
 */
export async function POST(request: Request) {
  if (!process.env.RESEND_WEBHOOK_SECRET?.trim()) return new NextResponse(null, { status: 404 });
  const rawBody = await request.text();
  const valid = validateResendSignature(rawBody, {
    svixId: request.headers.get("svix-id"),
    svixTimestamp: request.headers.get("svix-timestamp"),
    svixSignature: request.headers.get("svix-signature"),
  });
  if (!valid) return NextResponse.json({ error: "Invalid signature." }, { status: 403 });

  let event: { type?: string; data?: Record<string, unknown> };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const type = typeof event.type === "string" ? event.type : "";
  const data = (event.data ?? {}) as Record<string, unknown>;

  // Inbound email reply.
  if (type === "email.received" || type === "inbound.email.received") {
    const from = normalizeEmail(typeof data.from === "string" ? data.from : extractAddress(data.from));
    const text = typeof data.text === "string" ? data.text : typeof data.html === "string" ? String(data.html).replace(/<[^>]+>/g, " ") : "";
    const body = text.trim();
    if (!from || !body) return NextResponse.json({ ok: true, ignored: true });
    const match = await findLeadForInboundContact("email", from);
    if (!match) return NextResponse.json({ ok: true, ignored: true }); // Unknown sender — acknowledge, don't retry.
    await processInboundReply({
      organizationId: match.organizationId,
      leadId: match.leadId,
      channel: "email",
      body: body.slice(0, 5000),
      actorUserId: null,
      provider: "resend_outreach",
    });
    return NextResponse.json({ ok: true });
  }

  // Delivery status events.
  const mapped = type === "email.delivered" ? "delivered"
    : type === "email.bounced" || type === "email.failed" || type === "email.complained" ? "failed"
    : type === "email.sent" ? "sent"
    : null;
  if (!mapped) return NextResponse.json({ ok: true, ignored: true });
  const emailId = typeof data.email_id === "string" ? data.email_id : typeof (data as { id?: unknown }).id === "string" ? String((data as { id?: unknown }).id) : null;
  if (!emailId) return NextResponse.json({ ok: true, ignored: true });

  const updated = await applyDeliveryStatus("resend_outreach", emailId, mapped);
  if (updated && mapped === "failed") {
    await logActivity({
      organizationId: updated.organizationId,
      leadId: updated.message.leadId,
      campaignId: updated.message.campaignId,
      activityType: "message_delivery_failed",
      title: "Email delivery failed",
      detail: type === "email.bounced" ? "The recipient's mail server bounced the message." : type === "email.complained" ? "The recipient marked the message as spam." : "The provider reported the send as failed.",
      metadata: { providerMessageId: emailId, resendEvent: type },
      actorUserId: null,
    });
  }
  return NextResponse.json({ ok: true, updated: !!updated });
}

/** Resend inbound payloads sometimes wrap the sender: {from: {address, name}} or "Name <a@b.c>". */
function extractAddress(from: unknown): string {
  if (from && typeof from === "object" && typeof (from as { address?: unknown }).address === "string") {
    return (from as { address: string }).address;
  }
  if (typeof from === "string") {
    const match = from.match(/<([^>]+)>/);
    return match ? match[1] : from;
  }
  return "";
}
