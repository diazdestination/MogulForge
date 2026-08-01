import "server-only";
import { applyFieldMapping, SAMPLE_LEAD, type FieldMappingEntry } from "./mapping";

/**
 * Provider-neutral CRM adapter framework. One adapter is functional today —
 * the generic webhook/REST adapter. Branded connectors are honestly labeled
 * as in development / coming soon and cannot be connected.
 */

export type CrmProviderStatus = "available" | "in_development" | "coming_soon";

export type CrmProviderInfo = {
  id: string;
  label: string;
  status: CrmProviderStatus;
  description: string;
};

export const CRM_PROVIDERS: CrmProviderInfo[] = [
  {
    id: "generic_webhook",
    label: "Generic Webhook / REST",
    status: "available",
    description: "Send mapped lead data to any HTTP endpoint — works with custom CRMs, Zapier catch hooks, and internal tools.",
  },
  { id: "hubspot", label: "HubSpot", status: "in_development", description: "Native HubSpot contacts + deals sync." },
  { id: "gohighlevel", label: "GoHighLevel", status: "in_development", description: "Native GHL contacts and pipelines sync." },
  { id: "jobnimbus", label: "JobNimbus", status: "coming_soon", description: "Contacts and jobs sync for roofing teams." },
  { id: "servicetitan", label: "ServiceTitan", status: "coming_soon", description: "Customers and jobs sync for home services." },
  { id: "salesforce", label: "Salesforce", status: "coming_soon", description: "Leads and opportunities sync." },
  { id: "zapier", label: "Zapier / Make / n8n", status: "available", description: "Use the Generic Webhook adapter with a catch-hook URL from your automation tool." },
];

export function getCrmProvider(id: string): CrmProviderInfo | null {
  return CRM_PROVIDERS.find((p) => p.id === id) ?? null;
}

/** Providers that can actually be configured today (both use the generic adapter). */
export function isConnectableProvider(id: string): boolean {
  return getCrmProvider(id)?.status === "available";
}

export type GenericWebhookConfig = {
  url: string;
  /** Optional header name + value, e.g. Authorization: Bearer xyz. */
  authHeaderName?: string | null;
  authHeaderValue?: string | null;
};

export function parseGenericConfig(raw: unknown): { config: GenericWebhookConfig | null; error?: string } {
  if (!raw || typeof raw !== "object") return { config: null, error: "Connection config is required." };
  const { url, authHeaderName, authHeaderValue } = raw as Record<string, unknown>;
  if (typeof url !== "string" || !url.trim()) return { config: null, error: "A destination URL is required." };
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { config: null, error: "URL must use http or https." };
  } catch {
    return { config: null, error: "Destination URL is not valid." };
  }
  return {
    config: {
      url: url.trim(),
      authHeaderName: typeof authHeaderName === "string" && authHeaderName.trim() ? authHeaderName.trim().slice(0, 100) : null,
      authHeaderValue: typeof authHeaderValue === "string" && authHeaderValue.trim() ? authHeaderValue.trim().slice(0, 500) : null,
    },
  };
}

export type AdapterTestResult = {
  ok: boolean;
  statusCode: number | null;
  message: string;
  sentPayload: Record<string, unknown>;
};

/**
 * Test-before-activate: sends a clearly marked test payload (mapped sample lead)
 * to the configured endpoint and reports the real response. Never sends real leads.
 */
export async function testGenericConnection(config: GenericWebhookConfig, mapping: FieldMappingEntry[]): Promise<AdapterTestResult> {
  const mapped = mapping.length > 0 ? applyFieldMapping(mapping, SAMPLE_LEAD) : { ...SAMPLE_LEAD };
  const payload = { _test: true, _source: "revenue_rescue_connection_test", data: mapped };
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "RevenueRescue-CRM/1.0" };
  if (config.authHeaderName && config.authHeaderValue) headers[config.authHeaderName] = config.authHeaderValue;
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    return {
      ok: response.ok,
      statusCode: response.status,
      message: response.ok ? `Receiver accepted the test payload (HTTP ${response.status}).` : `Receiver responded with HTTP ${response.status}.`,
      sentPayload: payload,
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: null,
      message: error instanceof Error ? `Request failed: ${error.message.slice(0, 300)}` : "Request failed.",
      sentPayload: payload,
    };
  }
}

/** Pushes one mapped lead to the generic endpoint. Used by active outbound connections. */
export async function pushLeadGeneric(
  config: GenericWebhookConfig,
  mapping: FieldMappingEntry[],
  lead: Record<string, unknown>,
): Promise<{ ok: boolean; statusCode: number | null; message: string }> {
  const payload = { _source: "revenue_rescue", data: applyFieldMapping(mapping, lead) };
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "RevenueRescue-CRM/1.0" };
  if (config.authHeaderName && config.authHeaderValue) headers[config.authHeaderName] = config.authHeaderValue;
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    return { ok: response.ok, statusCode: response.status, message: response.ok ? "Delivered." : `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, statusCode: null, message: error instanceof Error ? error.message.slice(0, 300) : "Request failed." };
  }
}
