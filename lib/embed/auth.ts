import "server-only";
import { getOrganizationById, type Organization } from "../tenant";
import { PublicApiError } from "../public-api/http";
import { originAllowed, verifyEmbedToken, type EmbedClaims, type EmbedModule } from "./tokens";

export type EmbedContext = {
  org: Organization;
  claims: EmbedClaims;
};

/**
 * Validates an embed API request: Bearer embed token → signature + expiry →
 * module claim → Origin header must match the token's origin claim, which must
 * still be on the org's allow-list (revocable at any time).
 */
export async function requireEmbedSession(request: Request, module: EmbedModule): Promise<EmbedContext> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) throw new PublicApiError(401, "missing_embed_token", "Provide an embed session token via the Authorization: Bearer header.");

  const check = verifyEmbedToken(match[1].trim());
  if (!check.valid) {
    const message = check.reason === "expired" ? "The embed session has expired. Request a new token." : "The embed token is invalid.";
    throw new PublicApiError(401, `embed_token_${check.reason}`, message);
  }
  const claims = check.claims;
  if (!claims.modules.includes(module)) {
    throw new PublicApiError(403, "embed_module_not_allowed", `This embed session does not include the ${module} module.`);
  }

  // Origin enforcement: browser-sent Origin (or Referer fallback) must match the
  // token claim. Same-origin iframe requests may omit Origin; the token claim +
  // frame-ancestors CSP still bound where the embed can run.
  const requestOrigin = request.headers.get("origin") ?? (request.headers.get("referer") ? new URL(request.headers.get("referer")!).origin : null);
  const appOrigin = new URL(request.url).origin;
  if (requestOrigin && requestOrigin !== appOrigin && requestOrigin !== claims.origin) {
    throw new PublicApiError(403, "embed_origin_mismatch", "This embed session was issued for a different origin.");
  }

  const org = await getOrganizationById(claims.org);
  if (!org || org.status !== "active") throw new PublicApiError(403, "organization_inactive", "This organization is not active.");
  if (!originAllowed(claims.origin, org.allowedOrigins)) {
    throw new PublicApiError(403, "origin_not_approved", "The embedding origin is no longer approved for this organization.");
  }
  return { org, claims };
}

/** CORS headers for embed API responses — scoped to the token's approved origin. */
export function embedCorsHeaders(claims: EmbedClaims): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": claims.origin,
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    Vary: "Origin",
  };
}
