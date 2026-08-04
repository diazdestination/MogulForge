import "server-only";
import { ReplitConnectors } from "@replit/connectors-sdk";

/**
 * Live Replit-connector state for the calendar providers, plus a thin
 * authenticated proxy for their APIs. The connectors SDK injects/refreshes
 * OAuth tokens; this module never sees raw credentials.
 *
 * Connection state is cached briefly so the appointments dashboard doesn't
 * hit the connector service on every request.
 */

export type ConnectedCalendarProviders = { google: boolean; outlook: boolean; calendly: boolean };

const NOT_CONNECTED: ConnectedCalendarProviders = { google: false, outlook: false, calendly: false };
const CACHE_TTL_MS = 30_000;

let cache: { at: number; value: ConnectedCalendarProviders } | null = null;

function isHealthy(status: string | undefined | null): boolean {
  const s = (status ?? "").toLowerCase();
  return !["error", "failed", "revoked", "expired", "disconnected"].some((bad) => s.includes(bad));
}

export async function getConnectedCalendarProviders(force = false): Promise<ConnectedCalendarProviders> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  try {
    const connectors = new ReplitConnectors();
    // listConnections doesn't accept comma-separated; query all and filter client-side
    const connections = await connectors.listConnections();
    const has = (name: string) => connections.some((c) => c.connector_name === name && isHealthy(c.status));
    const value = { google: has("google-calendar"), outlook: has("outlook"), calendly: has("calendly") };
    cache = { at: Date.now(), value };
    return value;
  } catch (error) {
    // Honest failure mode: if the connector service is unreachable, report
    // nothing connected rather than pretending sync works.
    console.error("Calendar connector lookup failed", error);
    return NOT_CONNECTED;
  }
}

export type CalendarConnectorName = "google-calendar" | "outlook" | "calendly";

/** Authenticated JSON request against a connector API. Throws on non-2xx (except allow404). */
export async function connectorRequest<T = unknown>(
  connector: CalendarConnectorName,
  path: string,
  options?: { method?: string; body?: unknown; allow404?: boolean; headers?: Record<string, string> },
): Promise<{ status: number; data: T | null }> {
  const connectors = new ReplitConnectors();
  const baseHeaders: Record<string, string> = options?.body !== undefined ? { "Content-Type": "application/json" } : {};
  const response = await connectors.proxy(connector, path, {
    method: options?.method ?? "GET",
    body: options?.body,
    headers: { ...baseHeaders, ...options?.headers },
  });
  if (response.status === 404 && options?.allow404) return { status: 404, data: null };
  if (response.status === 204) return { status: 204, data: null };
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${connector} API ${options?.method ?? "GET"} ${path} failed (${response.status}): ${text.slice(0, 300)}`);
  }
  const data = (await response.json().catch(() => null)) as T | null;
  return { status: response.status, data };
}
