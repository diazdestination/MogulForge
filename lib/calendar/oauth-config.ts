import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Per-org calendar OAuth: provider endpoints, env-driven app credentials, and
 * signed state tokens for the authorize→callback round-trip. Pure module
 * (no DB, no server-only) so it is directly unit-testable.
 *
 * The OAuth apps themselves are platform-level (one Google Cloud / Azure app
 * for MogulForge); each org authorizes ITS OWN account against that app.
 * Configure via env: GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET and
 * MICROSOFT_OAUTH_CLIENT_ID / MICROSOFT_OAUTH_CLIENT_SECRET. Missing env
 * means the provider is honestly reported as "not configured" — never a
 * silent fallback.
 */

export const ORG_CALENDAR_PROVIDERS = ["google_calendar", "outlook_calendar"] as const;
export type OrgCalendarProvider = (typeof ORG_CALENDAR_PROVIDERS)[number];

export function isOrgCalendarProvider(value: string): value is OrgCalendarProvider {
  return (ORG_CALENDAR_PROVIDERS as readonly string[]).includes(value);
}

export type OAuthAppCredentials = { clientId: string; clientSecret: string };

type EnvLike = Record<string, string | undefined>;

/** Returns the platform OAuth app credentials for a provider, or null when unconfigured. */
export function getOAuthAppCredentials(provider: OrgCalendarProvider, env: EnvLike = process.env): OAuthAppCredentials | null {
  const clientId = (provider === "google_calendar" ? env.GOOGLE_OAUTH_CLIENT_ID : env.MICROSOFT_OAUTH_CLIENT_ID)?.trim();
  const clientSecret = (provider === "google_calendar" ? env.GOOGLE_OAUTH_CLIENT_SECRET : env.MICROSOFT_OAUTH_CLIENT_SECRET)?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export const PROVIDER_ENDPOINTS: Record<OrgCalendarProvider, { authUrl: string; tokenUrl: string; scope: string; apiBase: string }> = {
  google_calendar: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "openid email https://www.googleapis.com/auth/calendar.events",
    apiBase: "https://www.googleapis.com",
  },
  outlook_calendar: {
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "offline_access openid email User.Read Calendars.ReadWrite",
    apiBase: "https://graph.microsoft.com",
  },
};

/**
 * Named extra scope sets for incremental authorization (Google only).
 * "analytics" = read-only Search Console + GA4 — powers the lead-gen
 * analytics view. Never includes any send/write scope.
 */
export const GOOGLE_EXTRA_SCOPE_SETS = {
  analytics: [
    "https://www.googleapis.com/auth/webmasters.readonly",
    "https://www.googleapis.com/auth/analytics.readonly",
  ],
} as const;
export type GoogleExtraScopeSet = keyof typeof GOOGLE_EXTRA_SCOPE_SETS;

export function isGoogleExtraScopeSet(value: string): value is GoogleExtraScopeSet {
  return value in GOOGLE_EXTRA_SCOPE_SETS;
}

export function buildAuthorizationUrl(
  provider: OrgCalendarProvider,
  input: { clientId: string; redirectUri: string; state: string; extraScopes?: readonly string[] },
): string {
  const endpoint = PROVIDER_ENDPOINTS[provider];
  const scope = [endpoint.scope, ...(input.extraScopes ?? [])].join(" ");
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope,
    state: input.state,
  });
  if (provider === "google_calendar") {
    // Offline access + forced consent so Google always returns a refresh token.
    params.set("access_type", "offline");
    params.set("prompt", "consent");
    // Groundwork for incremental authorization: future features (e.g. Gmail
    // sending) can request extra scopes without losing already-granted ones.
    params.set("include_granted_scopes", "true");
  }
  return `${endpoint.authUrl}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Signed OAuth state (HMAC, same pattern as booking tokens). Binds the
// callback to the org + user that initiated the flow and expires quickly.
// ---------------------------------------------------------------------------

export type OAuthStateClaims = {
  org: string;
  user: string;
  provider: OrgCalendarProvider;
  /** Exact redirect_uri used at authorize time (must match at token exchange). */
  redirectUri: string;
  /** In-app path to send the browser back to afterwards. */
  returnTo: string;
  iat: number;
};

export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

function stateSecret(secret?: string) {
  const value = secret ?? process.env.SESSION_SECRET;
  if (!value) throw new Error("SESSION_SECRET is not configured");
  return `calendar-oauth.${value}`;
}

function sign(payload: string, secret?: string) {
  return createHmac("sha256", stateSecret(secret)).update(payload).digest("base64url");
}

export function issueOAuthState(
  input: { organizationId: string; userId: string; provider: OrgCalendarProvider; redirectUri: string; returnTo: string },
  options?: { secret?: string; nowSeconds?: number },
): string {
  const claims: OAuthStateClaims = {
    org: input.organizationId,
    user: input.userId,
    provider: input.provider,
    redirectUri: input.redirectUri,
    returnTo: input.returnTo,
    iat: options?.nowSeconds ?? Math.floor(Date.now() / 1000),
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${sign(payload, options?.secret)}`;
}

export type OAuthStateCheck = { ok: true; claims: OAuthStateClaims } | { ok: false; reason: string };

export function verifyOAuthState(state: string, options?: { secret?: string; nowSeconds?: number }): OAuthStateCheck {
  const parts = state.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  let expected: Buffer;
  try {
    expected = Buffer.from(sign(parts[0], options?.secret));
  } catch {
    return { ok: false, reason: "unconfigured" };
  }
  const given = Buffer.from(parts[1]);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad-signature" };
  let claims: OAuthStateClaims;
  try {
    claims = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as OAuthStateClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!claims.org || !claims.user || !isOrgCalendarProvider(claims.provider ?? "") || typeof claims.redirectUri !== "string") {
    return { ok: false, reason: "malformed" };
  }
  if (typeof claims.returnTo !== "string" || !claims.returnTo.startsWith("/")) return { ok: false, reason: "malformed" };
  const now = options?.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(claims.iat) || now - claims.iat > OAUTH_STATE_TTL_SECONDS || claims.iat - now > 60) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, claims };
}

/** Only same-app paths are safe redirect targets after the OAuth round-trip. */
export function safeReturnTo(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.includes("\\")) return fallback;
  return trimmed.slice(0, 500);
}
