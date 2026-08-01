import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Short-lived signed embed session tokens. Stateless HMAC tokens (no DB row):
 * base64url(JSON claims) + "." + HMAC signature. Claims carry org, user, role,
 * allowed modules, the approved origin, and expiry. Issued server-to-server via
 * POST /api/v1/embed/sessions and validated on every embed API call.
 *
 * Deliberately free of "server-only" so the Next proxy (CSP frame-ancestors)
 * and unit tests can verify tokens too.
 */

export const EMBED_MODULES = ["dashboard", "leads", "appointments", "lead_form"] as const;
export type EmbedModule = (typeof EMBED_MODULES)[number];

export function isEmbedModule(value: string): value is EmbedModule {
  return (EMBED_MODULES as readonly string[]).includes(value);
}

export const DEFAULT_EMBED_TTL_SECONDS = 15 * 60;
export const MAX_EMBED_TTL_SECONDS = 60 * 60;

export type EmbedClaims = {
  org: string;
  /** Optional external user identifier supplied by the host site. */
  uid: string | null;
  role: "viewer" | "editor";
  modules: EmbedModule[];
  origin: string;
  iat: number;
  exp: number;
};

function embedSecret(secret?: string) {
  const value = secret ?? process.env.SESSION_SECRET;
  if (!value) throw new Error("SESSION_SECRET is not configured");
  return `embed.${value}`;
}

function sign(payload: string, secret?: string) {
  return createHmac("sha256", embedSecret(secret)).update(payload).digest("base64url");
}

export function issueEmbedToken(
  input: {
    organizationId: string;
    userId?: string | null;
    role?: "viewer" | "editor";
    modules: EmbedModule[];
    origin: string;
    ttlSeconds?: number;
  },
  options?: { secret?: string; nowSeconds?: number },
): { token: string; claims: EmbedClaims } {
  const now = options?.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = Math.min(Math.max(input.ttlSeconds ?? DEFAULT_EMBED_TTL_SECONDS, 60), MAX_EMBED_TTL_SECONDS);
  const claims: EmbedClaims = {
    org: input.organizationId,
    uid: input.userId ?? null,
    role: input.role ?? "viewer",
    modules: input.modules,
    origin: input.origin,
    iat: now,
    exp: now + ttl,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return { token: `${payload}.${sign(payload, options?.secret)}`, claims };
}

export type EmbedTokenCheck =
  | { valid: true; claims: EmbedClaims }
  | { valid: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifyEmbedToken(token: string, options?: { secret?: string; nowSeconds?: number }): EmbedTokenCheck {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { valid: false, reason: "malformed" };
  const [payload, signature] = parts;
  const expected = sign(payload, options?.secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { valid: false, reason: "bad_signature" };
  let claims: EmbedClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { valid: false, reason: "malformed" };
  }
  if (!claims || typeof claims.org !== "string" || typeof claims.origin !== "string" || !Array.isArray(claims.modules)) {
    return { valid: false, reason: "malformed" };
  }
  const now = options?.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= now) return { valid: false, reason: "expired" };
  return { valid: true, claims };
}

/**
 * Origin normalization + matching for embed enforcement. Origins compare on
 * scheme + host + port; an allowed origin of "https://example.com" matches
 * exactly (no subdomain wildcards unless the entry starts with "*.").
 */
export function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function originAllowed(origin: string, allowedOrigins: string[]): boolean {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  const host = new URL(normalized).host;
  return allowedOrigins.some((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith("*.")) {
      const suffix = trimmed.slice(1); // ".example.com"
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    const allowed = normalizeOrigin(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (!allowed) return false;
    if (allowed === normalized) return true;
    // Accept http/https mismatch only for localhost development origins.
    const allowedUrl = new URL(allowed);
    const originUrl = new URL(normalized);
    return allowedUrl.host === originUrl.host && (originUrl.hostname === "localhost" || originUrl.hostname === "127.0.0.1");
  });
}
