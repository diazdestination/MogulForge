import "server-only";
import { getPool } from "@/lib/db";
import { getOrgGoogleAccessToken } from "@/lib/calendar/org-connections";

export type GbpOpportunityInput = {
  kind: "gbp_review";
  title: string;
  evidence: Record<string, unknown>;
  actionHint: string;
  dedupKey: string;
  leadId: null;
};

export type GbpSignalResult =
  | { status: "ok"; opportunities: GbpOpportunityInput[] }
  | { status: "not_connected" }
  | { status: "no_scope" }
  | { status: "error"; error: string };

const GBP_SCOPE = "https://www.googleapis.com/auth/business.manage";

/**
 * Fetches unanswered Google Business Profile reviews.
 * Returns not_connected / no_scope honestly when the org hasn't granted access.
 * Never throws — all errors are typed return values.
 */
export async function getGbpSignals(organizationId: string): Promise<GbpSignalResult> {
  const { rows } = await getPool().query(
    `SELECT granted_scopes FROM org_calendar_connections
     WHERE organization_id = $1 AND provider = 'google_calendar' AND status = 'connected'
     LIMIT 1`,
    [organizationId],
  );
  if (rows.length === 0) return { status: "not_connected" };

  const granted: string[] = Array.isArray(rows[0].granted_scopes) ? (rows[0].granted_scopes as string[]) : [];
  if (!granted.includes(GBP_SCOPE)) return { status: "no_scope" };

  let accessToken: string;
  try {
    const token = await getOrgGoogleAccessToken(organizationId);
    if (!token) return { status: "not_connected" };
    accessToken = token;
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : "Token fetch failed" };
  }

  try {
    const accountsRes = await fetch("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!accountsRes.ok) return { status: "error", error: `GBP accounts error ${accountsRes.status}` };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- external API
    const accountsData: any = await accountsRes.json();
    const accounts: { name: string }[] = accountsData.accounts ?? [];
    if (accounts.length === 0) return { status: "ok", opportunities: [] };

    const opportunities: GbpOpportunityInput[] = [];
    const accountName = String(accounts[0].name);

    const locRes = await fetch(
      `https://mybusiness.googleapis.com/v4/${accountName}/locations?readMask=name`,
      { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) },
    );
    if (!locRes.ok) return { status: "ok", opportunities: [] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- external API
    const locData: any = await locRes.json();
    const locations: { name: string }[] = locData.locations ?? [];

    for (const location of locations.slice(0, 3)) {
      const rvRes = await fetch(
        `https://mybusiness.googleapis.com/v4/${String(location.name)}/reviews?pageSize=20`,
        { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) },
      );
      if (!rvRes.ok) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- external API
      const rvData: any = await rvRes.json();
      const reviews: Array<{
        reviewId: string;
        reviewer?: { displayName?: string };
        starRating?: string;
        comment?: string;
        createTime?: string;
        reviewReply?: unknown;
      }> = rvData.reviews ?? [];

      for (const review of reviews) {
        if (review.reviewReply) continue;
        const reviewer = review.reviewer?.displayName ?? "A customer";
        const stars = review.starRating ?? "unknown";
        opportunities.push({
          kind: "gbp_review" as const,
          title: `${reviewer} left a ${stars}-star Google review that hasn't been replied to`,
          evidence: {
            reviewId: review.reviewId,
            reviewer,
            starRating: stars,
            comment: review.comment ? String(review.comment).slice(0, 300) : null,
            createTime: review.createTime,
            locationName: location.name,
          },
          actionHint: "Replying to reviews improves your local search ranking and shows new customers you care.",
          dedupKey: `gbp:${review.reviewId}`,
          leadId: null,
        });
      }
    }
    return { status: "ok", opportunities };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : "GBP fetch failed" };
  }
}
