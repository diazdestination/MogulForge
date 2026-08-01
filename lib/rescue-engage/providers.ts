/**
 * Outbound message provider abstraction. Pure module.
 *
 * No live SMS/email provider is wired up yet, so every channel honestly reports
 * "not connected" and campaigns run in Simulation Mode. The internal Resend key
 * (weekly lead digest) is deliberately NOT treated as a client outreach
 * provider — sending campaign email through it would contact real prospects
 * from an unverified shared sender. When Twilio/SendGrid/etc. credentials exist,
 * implement a provider here and `liveSendingAvailable` starts returning true.
 */
import type { CampaignChannel } from "./campaign-schema.ts";

export type ProviderStatus = {
  channel: CampaignChannel;
  connected: boolean;
  providerLabel: string | null;
  detail: string;
};

export function getProviderStatus(channel: CampaignChannel): ProviderStatus {
  if (channel === "sms") {
    return {
      channel,
      connected: false,
      providerLabel: null,
      detail: "No SMS provider is connected. SMS campaigns run in Simulation Mode — no text messages are sent.",
    };
  }
  return {
    channel,
    connected: false,
    providerLabel: null,
    detail: "No outreach email provider is connected. Email campaigns run in Simulation Mode — no emails are sent.",
  };
}

export function liveSendingAvailable(channel: CampaignChannel): boolean {
  return getProviderStatus(channel).connected;
}
