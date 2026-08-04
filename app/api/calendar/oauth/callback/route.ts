import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getMembership } from "@/lib/tenant";
import { MANAGER_ROLES } from "@/lib/roles";
import { verifyOAuthState } from "@/lib/calendar/oauth-config";
import { completeOrgCalendarConnection } from "@/lib/calendar/org-connections";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Shared OAuth callback for per-org Google/Outlook calendar connections.
 * The signed `state` (issued by the per-org start route) carries which org,
 * user, and provider the flow belongs to; we re-verify the session and
 * membership before storing anything, so a stolen callback URL is useless.
 * Always redirects back into the dashboard with ?calendar=... feedback.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const fail = (returnTo: string, reason: string) =>
    NextResponse.redirect(new URL(`${returnTo}${returnTo.includes("?") ? "&" : "?"}calendar=error&reason=${encodeURIComponent(reason)}`, url.origin));

  const stateParam = url.searchParams.get("state") ?? "";
  const check = verifyOAuthState(stateParam);
  if (!check.ok) {
    return fail("/dashboard/revenue-rescue/appointments", `state-${check.reason}`);
  }
  const { claims } = check;
  const returnTo = claims.returnTo;

  const providerError = url.searchParams.get("error");
  if (providerError) return fail(returnTo, providerError.slice(0, 100));
  const code = url.searchParams.get("code");
  if (!code) return fail(returnTo, "missing-code");

  // The browser completing the callback must be the same manager who started it.
  const user = await getCurrentUser();
  if (!user || user.id !== claims.user) return fail(returnTo, "session-mismatch");
  const membership = await getMembership(claims.org, user.id);
  if (!membership || !MANAGER_ROLES.includes(membership.role)) return fail(returnTo, "not-a-manager");

  try {
    const { accountEmail } = await completeOrgCalendarConnection({
      organizationId: claims.org,
      provider: claims.provider,
      code,
      redirectUri: claims.redirectUri,
      connectedBy: user.id,
    });
    await logAudit({
      organizationId: claims.org,
      actorUserId: user.id,
      actorLabel: user.email,
      action: "calendar.connection.connected",
      targetType: "organization",
      targetId: claims.org,
      metadata: { provider: claims.provider, accountEmail },
    });
    return NextResponse.redirect(new URL(`${returnTo}${returnTo.includes("?") ? "&" : "?"}calendar=connected`, url.origin));
  } catch (error) {
    console.error("Calendar OAuth token exchange failed", error);
    return fail(returnTo, "token-exchange-failed");
  }
}
