import { NextResponse } from "next/server";
import { ApiError, guard, requireEntitlement, requireMember } from "@/lib/api-guard";
import { MANAGER_ROLES } from "@/lib/roles";
import {
  buildAuthorizationUrl,
  getOAuthAppCredentials,
  isOrgCalendarProvider,
  issueOAuthState,
  safeReturnTo,
} from "@/lib/calendar/oauth-config";
import { disconnectOrgCalendar } from "@/lib/calendar/org-connections";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; provider: string }> };

const DEFAULT_RETURN = "/dashboard/revenue-rescue/appointments";

/**
 * Starts the per-org OAuth flow: redirects the manager's browser to the
 * provider's consent screen with a signed state bound to this org + user.
 */
export const GET = guard(async (request: Request, { params }: Ctx) => {
  const { orgId, provider } = await params;
  if (!isOrgCalendarProvider(provider)) throw new ApiError(404, "Unknown calendar provider.");
  const { org, user } = await requireMember(orgId, MANAGER_ROLES);
  await requireEntitlement(org.id, "appointments");
  if (!getOAuthAppCredentials(provider)) {
    throw new ApiError(
      503,
      provider === "google_calendar"
        ? "Google OAuth is not configured. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET."
        : "Microsoft OAuth is not configured. Set MICROSOFT_OAUTH_CLIENT_ID and MICROSOFT_OAUTH_CLIENT_SECRET.",
    );
  }
  const url = new URL(request.url);
  const redirectUri = `${url.origin}/api/calendar/oauth/callback`;
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"), DEFAULT_RETURN);
  const state = issueOAuthState({ organizationId: org.id, userId: user.id, provider, redirectUri, returnTo });
  const creds = getOAuthAppCredentials(provider);
  return NextResponse.redirect(buildAuthorizationUrl(provider, { clientId: creds!.clientId, redirectUri, state }));
});

/** Disconnects the org's own calendar account: revokes (best effort) and deletes stored tokens. */
export const DELETE = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId, provider } = await params;
  if (!isOrgCalendarProvider(provider)) throw new ApiError(404, "Unknown calendar provider.");
  const { org, user } = await requireMember(orgId, MANAGER_ROLES);
  const removed = await disconnectOrgCalendar(org.id, provider);
  if (removed) {
    await logAudit({
      organizationId: org.id,
      actorUserId: user.id,
      actorLabel: user.email,
      action: "calendar.connection.disconnected",
      targetType: "organization",
      targetId: org.id,
      metadata: { provider },
    });
  }
  return NextResponse.json({ disconnected: removed });
});
