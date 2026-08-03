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
  {
    id: "hubspot",
    label: "HubSpot",
    status: "available",
    description: "Native HubSpot contacts sync — connect with a private app access token; leads push as contacts and updates pull back with conflict protection.",
  },
  {
    id: "gohighlevel",
    label: "GoHighLevel",
    status: "available",
    description: "Native GHL contacts sync — connect with a private integration token + location ID; leads upsert as contacts and updates pull back safely.",
  },
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

// ---- Provider-specific configs ---------------------------------------------------

export type HubSpotConfig = { accessToken: string };
export type GhlConfig = { apiKey: string; locationId: string };
export type ProviderConfig =
  | { provider: "generic_webhook" | "zapier"; generic: GenericWebhookConfig }
  | { provider: "hubspot"; hubspot: HubSpotConfig }
  | { provider: "gohighlevel"; gohighlevel: GhlConfig };

/** Placeholder the API returns instead of stored secrets; clients echo it back to mean "keep the stored value". */
export const SECRET_PLACEHOLDER = "__stored_secret__";

/** Keys per provider whose values are credentials and must never reach the browser. */
const SECRET_CONFIG_KEYS: Record<string, string[]> = {
  generic_webhook: ["authHeaderValue"],
  zapier: ["authHeaderValue"],
  hubspot: ["accessToken"],
  gohighlevel: ["apiKey"],
};

/** Replaces credential values with a placeholder for API responses. */
export function redactConnectionConfig(provider: string, config: Record<string, unknown>): Record<string, unknown> {
  const redacted = { ...config };
  for (const key of SECRET_CONFIG_KEYS[provider] ?? []) {
    if (typeof redacted[key] === "string" && (redacted[key] as string).length > 0) redacted[key] = SECRET_PLACEHOLDER;
  }
  return redacted;
}

/** Restores stored secrets when the client echoes back the redaction placeholder. */
export function mergeStoredSecrets(
  provider: string,
  incoming: Record<string, unknown>,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...incoming };
  for (const key of SECRET_CONFIG_KEYS[provider] ?? []) {
    if (merged[key] === SECRET_PLACEHOLDER) merged[key] = stored[key];
  }
  return merged;
}

function requiredString(raw: Record<string, unknown>, key: string, max: number): string | null {
  const value = raw[key];
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim().slice(0, max);
}

/** Parses + validates connection config for any connectable provider. */
export function parseConnectionConfig(provider: string, raw: unknown): { config: Record<string, unknown> | null; error?: string } {
  if (provider === "hubspot") {
    if (!raw || typeof raw !== "object") return { config: null, error: "Connection config is required." };
    const accessToken = requiredString(raw as Record<string, unknown>, "accessToken", 300);
    if (!accessToken) return { config: null, error: "A HubSpot private app access token is required." };
    return { config: { accessToken } };
  }
  if (provider === "gohighlevel") {
    if (!raw || typeof raw !== "object") return { config: null, error: "Connection config is required." };
    const record = raw as Record<string, unknown>;
    const apiKey = requiredString(record, "apiKey", 500);
    const locationId = requiredString(record, "locationId", 100);
    if (!apiKey) return { config: null, error: "A GoHighLevel private integration token (API key) is required." };
    if (!locationId) return { config: null, error: "A GoHighLevel location ID is required." };
    return { config: { apiKey, locationId } };
  }
  // generic_webhook and zapier share the generic adapter.
  const { config, error } = parseGenericConfig(raw);
  return config ? { config: config as unknown as Record<string, unknown> } : { config: null, error };
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

// ---- HubSpot adapter --------------------------------------------------------------
// Auth: private app access token. Docs: https://developers.hubspot.com/docs/api/crm/contacts

const HUBSPOT_BASE = "https://api.hubapi.com";

async function hubspotFetch(config: HubSpotConfig, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${HUBSPOT_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.accessToken}`,
      "content-type": "application/json",
      "user-agent": "RevenueRescue-CRM/1.0",
      ...(init?.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
}

/** Test = a real read-only API call. Never creates data in the customer's HubSpot. */
export async function testHubSpotConnection(config: HubSpotConfig): Promise<AdapterTestResult> {
  try {
    const response = await hubspotFetch(config, "/crm/v3/objects/contacts?limit=1");
    if (response.ok) {
      return { ok: true, statusCode: response.status, message: "HubSpot accepted the token — contacts API reachable.", sentPayload: { readOnlyCheck: "GET /crm/v3/objects/contacts?limit=1" } };
    }
    const message =
      response.status === 401
        ? "HubSpot rejected the token (HTTP 401). Check the private app access token."
        : response.status === 403
          ? "Token is valid but missing scopes (HTTP 403). Grant crm.objects.contacts read + write."
          : `HubSpot responded with HTTP ${response.status}.`;
    return { ok: false, statusCode: response.status, message, sentPayload: { readOnlyCheck: "GET /crm/v3/objects/contacts?limit=1" } };
  } catch (error) {
    return { ok: false, statusCode: null, message: error instanceof Error ? `Request failed: ${error.message.slice(0, 300)}` : "Request failed.", sentPayload: {} };
  }
}

/** Default mapping targets are HubSpot contact property names. */
export const HUBSPOT_DEFAULT_MAPPING: FieldMappingEntry[] = [
  { source: "firstName", target: "firstname", transform: "none" },
  { source: "lastName", target: "lastname", transform: "none" },
  { source: "email", target: "email", transform: "lowercase" },
  { source: "phone", target: "phone", transform: "e164_us" },
  { source: "city", target: "city", transform: "none" },
  { source: "state", target: "state", transform: "none" },
  { source: "zip", target: "zip", transform: "none" },
];

/** Creates (or updates on email collision) a HubSpot contact from a mapped lead. */
export async function pushLeadHubSpot(
  config: HubSpotConfig,
  mapping: FieldMappingEntry[],
  lead: Record<string, unknown>,
): Promise<{ ok: boolean; statusCode: number | null; message: string }> {
  const mapped = applyFieldMapping(mapping.length > 0 ? mapping : HUBSPOT_DEFAULT_MAPPING, lead);
  const properties: Record<string, string> = {};
  for (const [key, value] of Object.entries(mapped)) {
    if (value !== null && value !== undefined && value !== "") properties[key] = String(value);
  }
  try {
    const response = await hubspotFetch(config, "/crm/v3/objects/contacts", { method: "POST", body: JSON.stringify({ properties }) });
    if (response.ok) return { ok: true, statusCode: response.status, message: "Contact created in HubSpot." };
    if (response.status === 409) {
      // Contact already exists — update it instead of failing (id is in the error message).
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      const existingId = body?.message?.match(/Existing ID:\s*(\d+)/)?.[1];
      if (existingId) {
        const patch = await hubspotFetch(config, `/crm/v3/objects/contacts/${existingId}`, { method: "PATCH", body: JSON.stringify({ properties }) });
        if (patch.ok) return { ok: true, statusCode: patch.status, message: `Existing HubSpot contact ${existingId} updated.` };
        return { ok: false, statusCode: patch.status, message: `Contact exists but update failed (HTTP ${patch.status}).` };
      }
      return { ok: true, statusCode: 409, message: "Contact already exists in HubSpot." };
    }
    return { ok: false, statusCode: response.status, message: `HubSpot responded with HTTP ${response.status}.` };
  } catch (error) {
    return { ok: false, statusCode: null, message: error instanceof Error ? error.message.slice(0, 300) : "Request failed." };
  }
}

export type RemoteContact = {
  externalRecordId: string;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  updatedAt: string | null;
};

/** Pulls recently modified HubSpot contacts (read-only) for inbound sync. */
export async function pullHubSpotContacts(config: HubSpotConfig, limit = 50): Promise<{ ok: boolean; message: string; contacts: RemoteContact[] }> {
  try {
    const response = await hubspotFetch(config, "/crm/v3/objects/contacts/search", {
      method: "POST",
      body: JSON.stringify({
        limit: Math.min(limit, 100),
        sorts: [{ propertyName: "lastmodifieddate", direction: "DESCENDING" }],
        properties: ["firstname", "lastname", "email", "phone", "lastmodifieddate"],
      }),
    });
    if (!response.ok) return { ok: false, message: `HubSpot responded with HTTP ${response.status}.`, contacts: [] };
    const body = (await response.json()) as { results?: Array<{ id: string; properties?: Record<string, string | null>; updatedAt?: string }> };
    const contacts: RemoteContact[] = (body.results ?? []).map((r) => ({
      externalRecordId: `hubspot:${r.id}`,
      email: r.properties?.email ?? null,
      phone: r.properties?.phone ?? null,
      firstName: r.properties?.firstname ?? null,
      lastName: r.properties?.lastname ?? null,
      updatedAt: r.properties?.lastmodifieddate ?? r.updatedAt ?? null,
    }));
    return { ok: true, message: `Fetched ${contacts.length} contacts.`, contacts };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message.slice(0, 300) : "Request failed.", contacts: [] };
  }
}

// ---- GoHighLevel adapter ----------------------------------------------------------
// Auth: private integration token (API 2.0). Docs: https://highlevel.stoplight.io/docs/integrations

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

async function ghlFetch(config: GhlConfig, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${GHL_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      version: GHL_VERSION,
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "RevenueRescue-CRM/1.0",
      ...(init?.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
}

/** Test = a real read-only API call scoped to the configured location. */
export async function testGhlConnection(config: GhlConfig): Promise<AdapterTestResult> {
  const check = `GET /contacts/?locationId=${config.locationId}&limit=1`;
  try {
    const response = await ghlFetch(config, `/contacts/?locationId=${encodeURIComponent(config.locationId)}&limit=1`);
    if (response.ok) {
      return { ok: true, statusCode: response.status, message: "GoHighLevel accepted the token — contacts API reachable for this location.", sentPayload: { readOnlyCheck: check } };
    }
    const message =
      response.status === 401
        ? "GoHighLevel rejected the token (HTTP 401). Check the private integration token."
        : response.status === 403
          ? "Token is valid but not authorized for this location or missing contacts scopes (HTTP 403)."
          : `GoHighLevel responded with HTTP ${response.status}.`;
    return { ok: false, statusCode: response.status, message, sentPayload: { readOnlyCheck: check } };
  } catch (error) {
    return { ok: false, statusCode: null, message: error instanceof Error ? `Request failed: ${error.message.slice(0, 300)}` : "Request failed.", sentPayload: {} };
  }
}

/** Default mapping targets are GHL contact field names. */
export const GHL_DEFAULT_MAPPING: FieldMappingEntry[] = [
  { source: "firstName", target: "firstName", transform: "none" },
  { source: "lastName", target: "lastName", transform: "none" },
  { source: "email", target: "email", transform: "lowercase" },
  { source: "phone", target: "phone", transform: "e164_us" },
  { source: "address", target: "address1", transform: "none" },
  { source: "city", target: "city", transform: "none" },
  { source: "state", target: "state", transform: "none" },
  { source: "zip", target: "postalCode", transform: "none" },
];

/** Upserts a GHL contact (GHL dedupes on email/phone server-side). */
export async function pushLeadGhl(
  config: GhlConfig,
  mapping: FieldMappingEntry[],
  lead: Record<string, unknown>,
): Promise<{ ok: boolean; statusCode: number | null; message: string }> {
  const mapped = applyFieldMapping(mapping.length > 0 ? mapping : GHL_DEFAULT_MAPPING, lead);
  const payload: Record<string, unknown> = { locationId: config.locationId };
  for (const [key, value] of Object.entries(mapped)) {
    if (value !== null && value !== undefined && value !== "") payload[key] = value;
  }
  try {
    const response = await ghlFetch(config, "/contacts/upsert", { method: "POST", body: JSON.stringify(payload) });
    if (response.ok) return { ok: true, statusCode: response.status, message: "Contact upserted in GoHighLevel." };
    return { ok: false, statusCode: response.status, message: `GoHighLevel responded with HTTP ${response.status}.` };
  } catch (error) {
    return { ok: false, statusCode: null, message: error instanceof Error ? error.message.slice(0, 300) : "Request failed." };
  }
}

/** Pulls recent GHL contacts (read-only) for inbound sync. */
export async function pullGhlContacts(config: GhlConfig, limit = 50): Promise<{ ok: boolean; message: string; contacts: RemoteContact[] }> {
  try {
    const response = await ghlFetch(config, `/contacts/?locationId=${encodeURIComponent(config.locationId)}&limit=${Math.min(limit, 100)}`);
    if (!response.ok) return { ok: false, message: `GoHighLevel responded with HTTP ${response.status}.`, contacts: [] };
    const body = (await response.json()) as {
      contacts?: Array<{ id: string; email?: string | null; phone?: string | null; firstName?: string | null; lastName?: string | null; dateUpdated?: string | null }>;
    };
    const contacts: RemoteContact[] = (body.contacts ?? []).map((c) => ({
      externalRecordId: `ghl:${c.id}`,
      email: c.email ?? null,
      phone: c.phone ?? null,
      firstName: c.firstName ?? null,
      lastName: c.lastName ?? null,
      updatedAt: c.dateUpdated ?? null,
    }));
    return { ok: true, message: `Fetched ${contacts.length} contacts.`, contacts };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message.slice(0, 300) : "Request failed.", contacts: [] };
  }
}

// ---- Provider dispatch ------------------------------------------------------------

/** Runs the provider-appropriate connection test. */
export async function testConnectionForProvider(
  provider: string,
  rawConfig: Record<string, unknown>,
  mapping: FieldMappingEntry[],
): Promise<AdapterTestResult> {
  if (provider === "hubspot") {
    const { config, error } = parseConnectionConfig("hubspot", rawConfig);
    if (!config) return { ok: false, statusCode: null, message: error ?? "Config incomplete.", sentPayload: {} };
    return testHubSpotConnection(config as unknown as HubSpotConfig);
  }
  if (provider === "gohighlevel") {
    const { config, error } = parseConnectionConfig("gohighlevel", rawConfig);
    if (!config) return { ok: false, statusCode: null, message: error ?? "Config incomplete.", sentPayload: {} };
    return testGhlConnection(config as unknown as GhlConfig);
  }
  const { config, error } = parseGenericConfig(rawConfig);
  if (!config) return { ok: false, statusCode: null, message: error ?? "Config incomplete.", sentPayload: {} };
  return testGenericConnection(config, mapping);
}

/** Pushes one lead through the provider-appropriate adapter. */
export async function pushLeadForProvider(
  provider: string,
  rawConfig: Record<string, unknown>,
  mapping: FieldMappingEntry[],
  lead: Record<string, unknown>,
): Promise<{ ok: boolean; statusCode: number | null; message: string }> {
  if (provider === "hubspot") {
    const { config, error } = parseConnectionConfig("hubspot", rawConfig);
    if (!config) return { ok: false, statusCode: null, message: error ?? "Config incomplete." };
    return pushLeadHubSpot(config as unknown as HubSpotConfig, mapping, lead);
  }
  if (provider === "gohighlevel") {
    const { config, error } = parseConnectionConfig("gohighlevel", rawConfig);
    if (!config) return { ok: false, statusCode: null, message: error ?? "Config incomplete." };
    return pushLeadGhl(config as unknown as GhlConfig, mapping, lead);
  }
  const { config, error } = parseGenericConfig(rawConfig);
  if (!config) return { ok: false, statusCode: null, message: error ?? "Config incomplete." };
  return pushLeadGeneric(config, mapping, lead);
}

/** Pulls recent remote contacts for providers that support inbound sync. */
export async function pullContactsForProvider(
  provider: string,
  rawConfig: Record<string, unknown>,
): Promise<{ ok: boolean; message: string; contacts: RemoteContact[] }> {
  if (provider === "hubspot") {
    const { config, error } = parseConnectionConfig("hubspot", rawConfig);
    if (!config) return { ok: false, message: error ?? "Config incomplete.", contacts: [] };
    return pullHubSpotContacts(config as unknown as HubSpotConfig);
  }
  if (provider === "gohighlevel") {
    const { config, error } = parseConnectionConfig("gohighlevel", rawConfig);
    if (!config) return { ok: false, message: error ?? "Config incomplete.", contacts: [] };
    return pullGhlContacts(config as unknown as GhlConfig);
  }
  return { ok: false, message: "This provider does not support inbound pull.", contacts: [] };
}
