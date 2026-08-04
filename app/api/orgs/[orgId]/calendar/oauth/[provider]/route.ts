import { NextResponse } from "next/server";
import { ApiError, guard, requireEntitlement, requireMember } from "@/lib/api-guard";
import { MANAGER_ROLES } from "@/lib/roles";
import {
  GOOGLE_EXTRA_SCOPE_SETS,
  buildAuthorizationUrl,
  getOAuthAppCredentials,
  isGoogleExtraScopeSet,
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
  // Connecting an account is foundational (identity + calendar groundwork used
  // by onboarding), so it's gated on the base module — not on "appointments",
  // which starter plans don't include. Appointment sync itself stays gated.
  await requireEntitlement(org.id, "revenue_rescue");
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
  // Incremental authorization: ?scopes=analytics asks for the read-only
  // Search Console + GA4 scopes on top of the base grant. Google-only;
  // include_granted_scopes keeps previously granted scopes intact.
  const scopeSet = url.searchParams.get("scopes") ?? "";
  const extraScopes =
    provider === "google_calendar" && isGoogleExtraScopeSet(scopeSet) ? GOOGLE_EXTRA_SCOPE_SETS[scopeSet] : undefined;
  const state = issueOAuthState({ organizationId: org.id, userId: user.id, provider, redirectUri, returnTo });
  const creds = getOAuthAppCredentials(provider);
  return NextResponse.redirect(buildAuthorizationUrl(provider, { clientId: creds!.clientId, redirectUri, state, extraScopes }));
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
