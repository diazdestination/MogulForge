/**
 * Outbound message provider abstraction. Pure module (unit tests import it
 * directly), credential state is read from environment variables at call time.
 *
 * SMS — Twilio: TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + a sender
 *   (TWILIO_PHONE_NUMBER or TWILIO_MESSAGING_SERVICE_SID).
 * Email — Resend outreach: OUTREACH_RESEND_API_KEY + OUTREACH_EMAIL_FROM.
 *   The internal RESEND_API_KEY (weekly lead digest) is deliberately NOT
 *   treated as a client outreach provider — sending campaign email through it
 *   would contact real prospects from an unverified shared sender. Outreach
 *   requires its own key and a verified From address, set explicitly.
 *
 * When credentials are missing, every channel honestly reports "not connected"
 * and campaigns fall back to Simulation Mode.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { CampaignChannel } from "./campaign-schema.ts";

export type ProviderStatus = {
  channel: CampaignChannel;
  connected: boolean;
  providerLabel: string | null;
  detail: string;
};

function twilioConfig(): { accountSid: string; authToken: string; from: string | null; messagingServiceSid: string | null } | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const from = process.env.TWILIO_PHONE_NUMBER?.trim() || null;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() || null;
  if (!accountSid || !authToken || (!from && !messagingServiceSid)) return null;
  return { accountSid, authToken, from, messagingServiceSid };
}

function resendOutreachConfig(): { apiKey: string; from: string } | null {
  const apiKey = process.env.OUTREACH_RESEND_API_KEY?.trim();
  const from = process.env.OUTREACH_EMAIL_FROM?.trim();
  if (!apiKey || !from) return null;
  return { apiKey, from };
}

export function getProviderStatus(channel: CampaignChannel): ProviderStatus {
  if (channel === "sms") {
    const cfg = twilioConfig();
    if (cfg) {
      return {
        channel,
        connected: true,
        providerLabel: "Twilio",
        detail: `Twilio is connected (sending from ${cfg.messagingServiceSid ? "a messaging service" : cfg.from}). Live SMS campaigns are available.`,
      };
    }
    return {
      channel,
      connected: false,
      providerLabel: null,
      detail: "No SMS provider is connected. SMS campaigns run in Simulation Mode — no text messages are sent. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER to enable live SMS.",
    };
  }
  const cfg = resendOutreachConfig();
  if (cfg) {
    return {
      channel,
      connected: true,
      providerLabel: "Resend",
      detail: `Resend is connected (sending as ${cfg.from}). Live email campaigns are available.`,
    };
  }
  return {
    channel,
    connected: false,
    providerLabel: null,
    detail: "No outreach email provider is connected. Email campaigns run in Simulation Mode — no emails are sent. Set OUTREACH_RESEND_API_KEY and OUTREACH_EMAIL_FROM (a verified sender) to enable live email.",
  };
}

export function liveSendingAvailable(channel: CampaignChannel): boolean {
  return getProviderStatus(channel).connected;
}

/** Provider name recorded on rescue_messages rows for live sends. */
export function providerName(channel: CampaignChannel): string {
  return channel === "sms" ? "twilio" : "resend_outreach";
}

export class ProviderSendError extends Error {
  permanent: boolean;
  constructor(message: string, permanent = false) {
    super(message);
    this.permanent = permanent;
  }
}

export type LiveSendInput = {
  channel: CampaignChannel;
  to: string; // normalized phone (sms) or email address
  subject: string | null;
  body: string;
  /** Absolute URL Twilio should POST delivery-status callbacks to (optional). */
  statusCallbackUrl?: string | null;
};

export type LiveSendResult = { providerMessageId: string | null };

/**
 * Sends one live message through the configured provider for the channel.
 * Throws ProviderSendError when unconfigured or the provider rejects the send.
 */
export async function sendLiveMessage(input: LiveSendInput): Promise<LiveSendResult> {
  if (input.channel === "sms") {
    const cfg = twilioConfig();
    if (!cfg) throw new ProviderSendError("Twilio is not configured.", true);
    const params = new URLSearchParams({ To: input.to, Body: input.body });
    if (cfg.messagingServiceSid) params.set("MessagingServiceSid", cfg.messagingServiceSid);
    else if (cfg.from) params.set("From", cfg.from);
    if (input.statusCallbackUrl) params.set("StatusCallback", input.statusCallbackUrl);
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    const payload = (await response.json().catch(() => null)) as { sid?: string; message?: string; code?: number } | null;
    if (!response.ok) {
      throw new ProviderSendError(`Twilio rejected the send (${response.status}${payload?.code ? ` code ${payload.code}` : ""}): ${payload?.message ?? "unknown error"}`, response.status >= 400 && response.status < 500);
    }
    return { providerMessageId: payload?.sid ?? null };
  }

  const cfg = resendOutreachConfig();
  if (!cfg) throw new ProviderSendError("Outreach email (Resend) is not configured.", true);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: cfg.from,
      to: [input.to],
      subject: input.subject || "Following up",
      text: input.body,
    }),
  });
  const payload = (await response.json().catch(() => null)) as { id?: string; message?: string } | null;
  if (!response.ok) {
    throw new ProviderSendError(`Resend rejected the send (${response.status}): ${payload?.message ?? "unknown error"}`, response.status >= 400 && response.status < 500);
  }
  return { providerMessageId: payload?.id ?? null };
}

/* ------------------------------------------------------------------ */
/* Webhook signature verification (pure helpers, unit-testable).       */
/* ------------------------------------------------------------------ */

/**
 * Validates Twilio's X-Twilio-Signature header: base64(HMAC-SHA1(authToken,
 * url + concat(sortedParamKey + value))). Returns false when no auth token is
 * configured — callers must treat that as "webhook disabled".
 */
export function validateTwilioSignature(url: string, params: Record<string, string>, signature: string | null, authToken?: string): boolean {
  const token = authToken ?? process.env.TWILIO_AUTH_TOKEN?.trim();
  if (!token || !signature) return false;
  const data = url + Object.keys(params).sort().map((key) => key + params[key]).join("");
  const expected = createHmac("sha1", token).update(Buffer.from(data, "utf-8")).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verifies a Resend (Svix-style) webhook signature. Header `svix-signature`
 * holds space-separated `v1,<base64>` entries; the signed content is
 * `${svixId}.${svixTimestamp}.${rawBody}` HMAC-SHA256'd with the base64
 * portion of the `whsec_...` secret.
 */
export function validateResendSignature(
  rawBody: string,
  headers: { svixId: string | null; svixTimestamp: string | null; svixSignature: string | null },
  secret?: string,
  nowMs?: number,
): boolean {
  const whsec = secret ?? process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!whsec || !headers.svixId || !headers.svixTimestamp || !headers.svixSignature) return false;
  const ts = Number(headers.svixTimestamp);
  if (!Number.isFinite(ts)) return false;
  const now = nowMs ?? Date.now();
  if (Math.abs(now / 1000 - ts) > 300) return false; // 5 minute replay window
  const key = Buffer.from(whsec.startsWith("whsec_") ? whsec.slice(6) : whsec, "base64");
  const expected = createHmac("sha256", key).update(`${headers.svixId}.${headers.svixTimestamp}.${rawBody}`).digest("base64");
  const expectedBuf = Buffer.from(expected);
  for (const part of headers.svixSignature.split(" ")) {
    const [, sig] = part.split(",", 2);
    if (!sig) continue;
    const candidate = Buffer.from(sig);
    if (candidate.length === expectedBuf.length && timingSafeEqual(candidate, expectedBuf)) return true;
  }
  return false;
}
