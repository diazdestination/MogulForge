import "server-only";
import { getPool } from "../db";
import { getOrganizationById, getEntitlement, type Organization } from "../tenant";
import { touchApiKey, verifyApiKey } from "./keys";
import { getPublicApiRateLimiter } from "./rate-limit";
import { PublicApiError } from "./http";
import type { ApiScope } from "./scopes";
import { ApiError } from "../api-guard";
import { recordUsageInBackground, requireActionCapacity } from "../usage";

export type PublicApiContext = {
  org: Organization;
  keyId: string;
  scopes: ApiScope[];
  /** Rate limit headers to attach to the response. */
  rateHeaders: Record<string, string>;
};

/** Best-effort daily usage counter bump; never blocks a request. */
function bumpUsage(organizationId: string) {
  getPool()
    .query(
      `INSERT INTO api_usage_counters (organization_id, day, requests) VALUES ($1, CURRENT_DATE, 1)
       ON CONFLICT (organization_id, day) DO UPDATE SET requests = api_usage_counters.requests + 1`,
      [organizationId],
    )
    .catch(() => {});
}

/**
 * Authenticates a public API request: Bearer API key → active org → entitlement →
 * scope check → rate limit. Throws PublicApiError with structured codes.
 */
export async function requireApiKey(request: Request, scope: ApiScope): Promise<PublicApiContext> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    throw new PublicApiError(401, "missing_api_key", "Provide an API key via the Authorization: Bearer header.");
  }
  const verified = await verifyApiKey(match[1].trim());
  if (!verified) throw new PublicApiError(401, "invalid_api_key", "The API key is invalid or has been revoked.");

  const rate = getPublicApiRateLimiter().check(verified.keyId);
  const rateHeaders: Record<string, string> = {
    "X-RateLimit-Limit": String(rate.limit),
    "X-RateLimit-Remaining": String(rate.remaining),
    "X-RateLimit-Reset": String(rate.resetAt),
  };
  if (!rate.allowed) {
    throw new PublicApiError(429, "rate_limited", "Rate limit exceeded. Retry after the window resets.", {
      retry_after_seconds: Math.max(1, rate.resetAt - Math.floor(Date.now() / 1000)),
    });
  }

  const org = await getOrganizationById(verified.organizationId);
  if (!org || org.status !== "active") {
    throw new PublicApiError(403, "organization_inactive", "This organization is not active.");
  }
  const entitlement = await getEntitlement(org.id, "api_access");
  if (!entitlement || !entitlement.enabled) {
    throw new PublicApiError(403, "api_access_disabled", "Public API access is not enabled for this organization.");
  }
  if (!verified.scopes.includes(scope)) {
    throw new PublicApiError(403, "insufficient_scope", `This API key is missing the required scope: ${scope}.`, {
      required_scope: scope,
      granted_scopes: verified.scopes,
    });
  }

  // Plan gate: suspended/cancelled accounts and exhausted api_requests limits
  // block API usage (this request itself counts as 1).
  try {
    await requireActionCapacity(org.id, { api_requests: 1 });
  } catch (error) {
    if (error instanceof ApiError && error.code === "usage_limit_reached") {
      throw new PublicApiError(429, "usage_limit_reached", error.message);
    }
    if (error instanceof ApiError && error.code === "account_blocked") {
      throw new PublicApiError(403, "account_blocked", error.message);
    }
    throw error;
  }

  touchApiKey(verified.keyId);
  bumpUsage(org.id);
  recordUsageInBackground(org.id, "api_requests", 1);
  return { org, keyId: verified.keyId, scopes: verified.scopes, rateHeaders };
}
