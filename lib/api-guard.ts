import "server-only";
import { NextResponse } from "next/server";
import { getCurrentUser, type SessionUser } from "./auth";
import { isAdmin as hasLegacyAdminCookie } from "./admin-auth";
import { getMembership, getOrganizationById, getEntitlement, type Organization } from "./tenant";
import { FEATURE_LABELS, type FeatureKey } from "./entitlements";
import type { OrgRole } from "./roles";

/**
 * Server-side enforcement for API routes. Identity, org membership, role, and
 * entitlements are always derived from the session + database — never from the client.
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

type RouteHandler<Ctx> = (request: Request, context: Ctx) => Promise<NextResponse | Response>;

/** Wraps a route handler so thrown ApiErrors become clean JSON error responses. */
export function guard<Ctx>(handler: RouteHandler<Ctx>): RouteHandler<Ctx> {
  return async (request, context) => {
    try {
      return await handler(request, context);
    } catch (error) {
      if (error instanceof ApiError) {
        return NextResponse.json(
          { error: error.message, ...(error.code ? { code: error.code } : {}) },
          { status: error.status },
        );
      }
      console.error("Unhandled API error", error);
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

/** Requires a signed-in user. 401 otherwise. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new ApiError(401, "Authentication required.", "unauthenticated");
  return user;
}

export type OrgContext = {
  user: SessionUser;
  org: Organization;
  role: OrgRole;
  membershipId: string;
};

/**
 * Requires the current user to be a member of the organization (optionally with one of
 * `allowedRoles`). The orgId in the URL is only a resource identifier — access is decided
 * by the membership row in the database.
 */
export async function requireMember(organizationId: string, allowedRoles?: OrgRole[]): Promise<OrgContext> {
  const user = await requireUser();
  const membership = await getMembership(organizationId, user.id);
  if (!membership) throw new ApiError(403, "You do not have access to this organization.", "forbidden_org");
  const org = await getOrganizationById(organizationId);
  if (!org) throw new ApiError(403, "You do not have access to this organization.", "forbidden_org");
  if (org.status !== "active") throw new ApiError(403, "This organization is not active.", "org_inactive");
  if (allowedRoles && !allowedRoles.includes(membership.role)) {
    throw new ApiError(403, "Your role does not permit this action.", "forbidden_role");
  }
  return { user, org, role: membership.role, membershipId: membership.membershipId };
}

/** Requires the org to have a feature entitlement enabled. Clear 403 when missing. */
export async function requireEntitlement(organizationId: string, featureKey: FeatureKey) {
  const entitlement = await getEntitlement(organizationId, featureKey);
  if (!entitlement || !entitlement.enabled) {
    throw new ApiError(
      403,
      `The ${FEATURE_LABELS[featureKey]} module is not enabled for this organization.`,
      "entitlement_required",
    );
  }
  return entitlement;
}

export type PlatformAdminContext = {
  user: SessionUser | null;
  actorLabel: string;
};

/**
 * Requires a MogulForge platform admin: either a signed-in user with a platform role,
 * or the legacy ADMIN_PASSWORD cookie (folded in as platform admin).
 */
export async function requirePlatformAdmin(): Promise<PlatformAdminContext> {
  const user = await getCurrentUser();
  if (user?.platformRole) return { user, actorLabel: `${user.email} (${user.platformRole})` };
  if (await hasLegacyAdminCookie()) return { user: null, actorLabel: "platform-admin (password)" };
  if (user) throw new ApiError(403, "Platform admin access required.", "forbidden_platform");
  throw new ApiError(401, "Authentication required.", "unauthenticated");
}

/** Parses a JSON body, throwing a 400 ApiError when invalid. */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") throw new ApiError(400, "Invalid JSON body.");
  return body as Record<string, unknown>;
}
