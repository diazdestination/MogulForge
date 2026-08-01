import { requireApiKey } from "@/lib/public-api/auth";
import { guardV1, PublicApiError, readV1Json } from "@/lib/public-api/http";
import {
  DEFAULT_EMBED_TTL_SECONDS,
  EMBED_MODULES,
  isEmbedModule,
  issueEmbedToken,
  normalizeOrigin,
  originAllowed,
  type EmbedModule,
} from "@/lib/embed/tokens";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/embed/sessions — server-to-server issuance of short-lived signed
 * embed tokens. Scope: embed:write. The requested origin must be on the org's
 * approved allow-list; tokens carry org/user/role/modules/origin/expiry claims.
 */
export const POST = guardV1(async (request: Request) => {
  const ctx = await requireApiKey(request, "embed:write");
  const body = await readV1Json(request);

  const rawOrigin = typeof body.origin === "string" ? body.origin.trim() : "";
  const origin = normalizeOrigin(rawOrigin);
  if (!origin) throw new PublicApiError(422, "invalid_origin", "origin must be a valid http(s) origin, e.g. https://www.example.com.");
  if (!originAllowed(origin, ctx.org.allowedOrigins)) {
    throw new PublicApiError(403, "origin_not_approved", "This origin is not on the organization's approved origins list.", {
      origin,
    });
  }

  const rawModules = Array.isArray(body.modules) ? body.modules : [];
  const modules = rawModules.filter((m): m is EmbedModule => typeof m === "string" && isEmbedModule(m));
  if (modules.length === 0) {
    throw new PublicApiError(422, "invalid_modules", `modules must include at least one of: ${EMBED_MODULES.join(", ")}.`);
  }

  const role = body.role === "editor" ? "editor" : "viewer";
  const ttlRaw = body.ttl_seconds ?? body.ttlSeconds;
  const ttlSeconds = typeof ttlRaw === "number" && Number.isFinite(ttlRaw) ? ttlRaw : DEFAULT_EMBED_TTL_SECONDS;

  const { token, claims } = issueEmbedToken({
    organizationId: ctx.org.id,
    userId: typeof body.user_id === "string" ? body.user_id.slice(0, 100) : typeof body.userId === "string" ? body.userId.slice(0, 100) : null,
    role,
    modules,
    origin,
    ttlSeconds,
  });
  return NextResponse.json(
    { data: { token, expires_at: new Date(claims.exp * 1000).toISOString(), modules, origin, role } },
    { status: 201, headers: ctx.rateHeaders },
  );
});
