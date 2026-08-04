import "server-only";
import { getPool } from "../db";
import { decryptToken, encryptToken } from "./token-crypto";
import {
  PROVIDER_ENDPOINTS,
  getOAuthAppCredentials,
  type OrgCalendarProvider,
} from "./oauth-config";
import { connectorRequest, getConnectedCalendarProviders } from "./connections";
import { sendOrgAlertInBackground } from "../org-alerts";
import { buildCalendarConnectionErrorEmail } from "../org-alerts-content.ts";
import { SITE_URL } from "../site";

/**
 * Per-org calendar OAuth connections: each organization can authorize its own
 * Google Calendar / Outlook account. Tokens are stored AES-256-GCM encrypted
 * (key derived from SESSION_SECRET) in org_calendar_connections.
 *
 * Request routing rule: when an org has its own connection for a provider,
 * ALL calendar traffic for that org+provider uses the org's account. Only
 * orgs WITHOUT their own connection fall back to the workspace-level Replit
 * connector (legacy single-account behavior). A broken org connection never
 * silently falls back to the workspace account — that would push a client's
 * bookings to the platform owner's calendar.
 */

export type OrgCalendarConnectionStatus = "active" | "error";

export type OrgCalendarConnection = {
  id: string;
  organizationId: string;
  provider: OrgCalendarProvider;
  accountEmail: string | null;
  status: OrgCalendarConnectionStatus;
  createdAt: string;
};

type ConnectionRow = {
  id: string;
  organization_id: string;
  provider: OrgCalendarProvider;
  account_email: string | null;
  access_token_enc: string;
  refresh_token_enc: string | null;
  expires_at: string | null;
  status: OrgCalendarConnectionStatus;
  refresh_failure_count: number;
  created_at: string;
  /** Space-separated scopes the provider actually granted (null on pre-scope rows). */
  granted_scopes: string | null;
};

/** Consecutive token-refresh failures before a connection is marked broken. */
export const REFRESH_ERROR_THRESHOLD = 3;

async function getConnectionRow(organizationId: string, provider: OrgCalendarProvider): Promise<ConnectionRow | null> {
  const { rows } = await getPool().query(
    "SELECT * FROM org_calendar_connections WHERE organization_id = $1 AND provider = $2",
    [organizationId, provider],
  );
  return rows[0] ?? null;
}

/** Public (safe) view of an org's own calendar connections, for the UI. */
export async function listOrgCalendarConnections(organizationId: string): Promise<OrgCalendarConnection[]> {
  const { rows } = await getPool().query(
    "SELECT id, organization_id, provider, account_email, status, created_at FROM org_calendar_connections WHERE organization_id = $1",
    [organizationId],
  );
  return rows.map((r) => ({
    id: r.id,
    organizationId: r.organization_id,
    provider: r.provider,
    accountEmail: r.account_email,
    status: r.status === "error" ? "error" : "active",
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}

// ---------------------------------------------------------------------------
// OAuth token exchange / refresh
// ---------------------------------------------------------------------------

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  /** Space-separated scopes the provider actually granted. */
  scope?: string;
  error?: string;
  error_description?: string;
};

async function tokenRequest(provider: OrgCalendarProvider, params: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(PROVIDER_ENDPOINTS[provider].tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const data = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || !data.access_token) {
    throw new Error(
      `${provider} token endpoint failed (${response.status}): ${data.error ?? ""} ${data.error_description ?? ""}`.trim(),
    );
  }
  return data;
}

function decodeJwtEmail(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      email?: string; preferred_username?: string;
    };
    const email = payload.email ?? payload.preferred_username ?? null;
    return typeof email === "string" && email.includes("@") ? email.toLowerCase().slice(0, 320) : null;
  } catch {
    return null;
  }
}

/**
 * Exchanges an authorization code and stores the org's connection (upsert —
 * reconnecting replaces the previous tokens). Returns the account email when
 * the provider reported one.
 */
export async function completeOrgCalendarConnection(input: {
  organizationId: string;
  provider: OrgCalendarProvider;
  code: string;
  redirectUri: string;
  connectedBy: string;
}): Promise<{ accountEmail: string | null }> {
  const creds = getOAuthAppCredentials(input.provider);
  if (!creds) throw new Error(`${input.provider} OAuth app is not configured`);
  const tokens = await tokenRequest(input.provider, {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });
  const accountEmail = decodeJwtEmail(tokens.id_token);
  const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null;
  await getPool().query(
    `INSERT INTO org_calendar_connections
       (organization_id, provider, account_email, access_token_enc, refresh_token_enc, expires_at, connected_by, granted_scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (organization_id, provider) DO UPDATE SET
       account_email = EXCLUDED.account_email,
       access_token_enc = EXCLUDED.access_token_enc,
       refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, org_calendar_connections.refresh_token_enc),
       expires_at = EXCLUDED.expires_at,
       connected_by = EXCLUDED.connected_by,
       granted_scopes = COALESCE(EXCLUDED.granted_scopes, org_calendar_connections.granted_scopes),
       status = 'active',
       refresh_failure_count = 0,
       last_refresh_error = NULL,
       updated_at = now()`,
    [
      input.organizationId,
      input.provider,
      accountEmail,
      encryptToken(tokens.access_token as string),
      tokens.refresh_token ? encryptToken(tokens.refresh_token) : null,
      expiresAt,
      input.connectedBy,
      typeof tokens.scope === "string" ? tokens.scope.slice(0, 2000) : null,
    ],
  );
  return { accountEmail };
}

/** Best-effort provider-side revocation + hard delete of the stored tokens. */
export async function disconnectOrgCalendar(organizationId: string, provider: OrgCalendarProvider): Promise<boolean> {
  const row = await getConnectionRow(organizationId, provider);
  if (!row) return false;
  if (provider === "google_calendar") {
    // Google supports token revocation; revoke the refresh token (which also
    // invalidates derived access tokens). Microsoft has no public revoke
    // endpoint — deleting our copy stops all syncing, which is the contract.
    const token = decryptToken(row.refresh_token_enc ?? "") ?? decryptToken(row.access_token_enc);
    if (token) {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" })
        .catch((error) => console.error("Google token revocation failed (tokens deleted anyway)", error));
    }
  }
  await getPool().query(
    "DELETE FROM org_calendar_connections WHERE organization_id = $1 AND provider = $2",
    [organizationId, provider],
  );
  return true;
}

/**
 * Records a failed token refresh. After REFRESH_ERROR_THRESHOLD consecutive
 * failures the connection flips to 'error' (surfaced as "Reconnect" in the
 * Appointments UI) and the org's notification addresses get an email nudge —
 * once per outage, mirroring the CRM connection alert pattern.
 */
async function recordRefreshFailure(row: ConnectionRow, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
  const { rows } = await getPool().query(
    `UPDATE org_calendar_connections
     SET refresh_failure_count = refresh_failure_count + 1, last_refresh_error = $3, updated_at = now()
     WHERE organization_id = $1 AND provider = $2
     RETURNING refresh_failure_count, status`,
    [row.organization_id, row.provider, message],
  );
  const count = Number(rows[0]?.refresh_failure_count ?? 0);
  if (count < REFRESH_ERROR_THRESHOLD || rows[0]?.status !== "active") return;
  const flipped = await getPool().query(
    `UPDATE org_calendar_connections SET status = 'error', updated_at = now()
     WHERE organization_id = $1 AND provider = $2 AND status = 'active'`,
    [row.organization_id, row.provider],
  );
  if ((flipped.rowCount ?? 0) === 0) return; // another server flipped it first — alert already sent
  try {
    const { rows: orgRows } = await getPool().query("SELECT name FROM organizations WHERE id = $1", [row.organization_id]);
    sendOrgAlertInBackground(
      row.organization_id,
      "calendarConnectionAlerts",
      buildCalendarConnectionErrorEmail({
        orgName: orgRows[0]?.name ? String(orgRows[0].name) : "Your organization",
        providerLabel: row.provider === "google_calendar" ? "Google Calendar" : "Outlook Calendar",
        accountEmail: row.account_email,
        consecutiveFailures: count,
        lastError: message,
        appointmentsUrl: `${SITE_URL}/dashboard/revenue-rescue/appointments`,
      }),
    );
  } catch (alertError) {
    console.error(`Calendar connection error alert failed for organization ${row.organization_id}`, alertError);
  }
}

/** Returns a valid (refreshed if needed) access token for the org's own connection, or throws. */
async function getValidAccessToken(row: ConnectionRow): Promise<string> {
  const expiresSoon = row.expires_at ? new Date(row.expires_at).getTime() - Date.now() < 2 * 60 * 1000 : false;
  const access = decryptToken(row.access_token_enc);
  if (access && !expiresSoon) return access;

  const refresh = row.refresh_token_enc ? decryptToken(row.refresh_token_enc) : null;
  if (!refresh) {
    if (access) return access; // no refresh token; let the API call itself fail if expired
    throw new Error(`Stored ${row.provider} tokens cannot be decrypted (SESSION_SECRET rotated?) — reconnect required`);
  }
  const creds = getOAuthAppCredentials(row.provider);
  if (!creds) throw new Error(`${row.provider} OAuth app is no longer configured`);
  let tokens: TokenResponse;
  try {
    tokens = await tokenRequest(row.provider, {
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    });
  } catch (error) {
    await recordRefreshFailure(row, error).catch((trackError) =>
      console.error(`Failed to record calendar refresh failure for org ${row.organization_id}`, trackError),
    );
    throw error;
  }
  const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null;
  await getPool().query(
    `UPDATE org_calendar_connections
     SET access_token_enc = $3, refresh_token_enc = COALESCE($4, refresh_token_enc), expires_at = $5,
         status = 'active', refresh_failure_count = 0, last_refresh_error = NULL, updated_at = now()
     WHERE organization_id = $1 AND provider = $2`,
    [
      row.organization_id,
      row.provider,
      encryptToken(tokens.access_token as string),
      tokens.refresh_token ? encryptToken(tokens.refresh_token) : null,
      expiresAt,
    ],
  );
  return tokens.access_token as string;
}

// ---------------------------------------------------------------------------
// Org-aware calendar requests (org connection first, workspace fallback)
// ---------------------------------------------------------------------------

export type CalendarRoute = "org" | "workspace";

/**
 * Decides which credentials serve calendar traffic for an org+provider:
 * "org" when the org has its own connection, "workspace" when only the
 * legacy workspace connector is available, null when neither is.
 */
export async function resolveCalendarRoute(
  organizationId: string,
  provider: OrgCalendarProvider,
): Promise<CalendarRoute | null> {
  const row = await getConnectionRow(organizationId, provider);
  if (row) return "org";
  const connected = await getConnectedCalendarProviders();
  if (provider === "google_calendar" && connected.google) return "workspace";
  if (provider === "outlook_calendar" && connected.outlook) return "workspace";
  return null;
}

/** Whether the org has its own stored connection for a provider (regardless of token health). */
export async function hasOrgCalendarConnection(organizationId: string, provider: OrgCalendarProvider): Promise<boolean> {
  return (await getConnectionRow(organizationId, provider)) !== null;
}

/**
 * The org's Google connection state incl. which scopes were actually granted —
 * used to decide whether Search Console / GA4 access exists. granted_scopes is
 * null on connections made before scope tracking; treat that as "calendar only"
 * (fail closed — never assume broader access than we can prove).
 */
export async function getOrgGoogleAuth(
  organizationId: string,
): Promise<{ connected: boolean; accountEmail: string | null; grantedScopes: string[] }> {
  const row = await getConnectionRow(organizationId, "google_calendar");
  if (!row) return { connected: false, accountEmail: null, grantedScopes: [] };
  return {
    connected: true,
    accountEmail: row.account_email,
    grantedScopes: (row.granted_scopes ?? "").split(/\s+/).filter(Boolean),
  };
}

/** A valid (refreshed if needed) access token for the org's own Google connection. Throws when absent/broken. */
export async function getOrgGoogleAccessToken(organizationId: string): Promise<string> {
  const row = await getConnectionRow(organizationId, "google_calendar");
  if (!row) throw new Error(`Org ${organizationId} has no Google connection`);
  return getValidAccessToken(row);
}

/**
 * Authenticated JSON request against the calendar API via an EXPLICIT
 * credential route. Events must always be read/updated/deleted with the same
 * account that created them — callers pass the stored credential source, never
 * re-resolve it dynamically (a route flip would produce false 404s). Same
 * contract as connectorRequest (throws on non-2xx except allow404). Paths are
 * shared between both transports (e.g. "/calendar/v3/..." for Google,
 * "/v1.0/me/events" for Graph).
 */
export async function orgCalendarRequestVia<T = unknown>(
  route: CalendarRoute,
  organizationId: string,
  provider: OrgCalendarProvider,
  path: string,
  options?: { method?: string; body?: unknown; allow404?: boolean; headers?: Record<string, string> },
): Promise<{ status: number; data: T | null }> {
  if (route === "workspace") {
    return connectorRequest<T>(provider === "google_calendar" ? "google-calendar" : "outlook", path, options);
  }
  const row = await getConnectionRow(organizationId, provider);
  if (!row) throw new Error(`Org ${organizationId} has no ${provider} connection (was it disconnected mid-sync?)`);
  const accessToken = await getValidAccessToken(row);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    ...(options?.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...options?.headers,
  };
  const response = await fetch(`${PROVIDER_ENDPOINTS[provider].apiBase}${path}`, {
    method: options?.method ?? "GET",
    headers,
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  if (response.status === 404 && options?.allow404) return { status: 404, data: null };
  if (response.status === 204) return { status: 204, data: null };
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `${provider} API ${options?.method ?? "GET"} ${path} failed for org ${organizationId} (${response.status}): ${text.slice(0, 300)}`,
    );
  }
  const data = (await response.json().catch(() => null)) as T | null;
  return { status: response.status, data };
}
