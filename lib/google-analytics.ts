import "server-only";
import { getPool } from "./db";
import { GOOGLE_EXTRA_SCOPE_SETS } from "./calendar/oauth-config";
import { getOrgGoogleAccessToken, getOrgGoogleAuth } from "./calendar/org-connections";
import { getOrgSettings } from "./org-settings";
import { getOrganizationById } from "./tenant";

/**
 * Read-only Google Search Console + GA4 ingestion for the lead-gen analytics
 * view. Uses the org's OWN Google connection (per-org OAuth) — never a
 * workspace credential — and only when the read scopes were actually granted
 * (checked against granted_scopes; a bare calendar grant is honestly reported
 * as "access not granted", never guessed at).
 *
 * Snapshots are stored per source; a failed pull stores the error instead of
 * leaving stale "ok" data pretending to be fresh.
 */

const [SEARCH_CONSOLE_SCOPE, GA4_SCOPE] = GOOGLE_EXTRA_SCOPE_SETS.analytics;
const RANGE_DAYS = 28;
const ROW_LIMIT = 10;

export type AnalyticsSource = "search_console" | "ga4";

export type AnalyticsAccess = {
  googleConnected: boolean;
  accountEmail: string | null;
  searchConsoleGranted: boolean;
  ga4Granted: boolean;
};

export async function getAnalyticsAccess(organizationId: string): Promise<AnalyticsAccess> {
  const auth = await getOrgGoogleAuth(organizationId);
  return {
    googleConnected: auth.connected,
    accountEmail: auth.accountEmail,
    searchConsoleGranted: auth.grantedScopes.includes(SEARCH_CONSOLE_SCOPE),
    ga4Granted: auth.grantedScopes.includes(GA4_SCOPE),
  };
}

export type AnalyticsSnapshot = {
  source: AnalyticsSource;
  status: "ok" | "error";
  error: string | null;
  data: Record<string, unknown>;
  capturedAt: string;
};

export async function getAnalyticsSnapshots(organizationId: string): Promise<AnalyticsSnapshot[]> {
  const { rows } = await getPool().query(
    "SELECT source, status, error, data, captured_at FROM org_analytics_snapshots WHERE organization_id = $1",
    [organizationId],
  );
  return rows.map((r) => ({
    source: r.source,
    status: r.status,
    error: r.error,
    data: r.data ?? {},
    capturedAt: r.captured_at instanceof Date ? r.captured_at.toISOString() : String(r.captured_at),
  }));
}

async function storeSnapshot(
  organizationId: string,
  source: AnalyticsSource,
  result: { data: Record<string, unknown> } | { error: string },
): Promise<void> {
  const ok = "data" in result;
  await getPool().query(
    `INSERT INTO org_analytics_snapshots (organization_id, source, status, error, data, captured_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (organization_id, source)
     DO UPDATE SET status = EXCLUDED.status, error = EXCLUDED.error, data = EXCLUDED.data, captured_at = now()`,
    [organizationId, source, ok ? "ok" : "error", ok ? null : result.error, JSON.stringify(ok ? result.data : {})],
  );
}

async function googleGet<T>(token: string, url: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Google API ${url.split("?")[0]} failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return (await res.json()) as T;
}

async function googlePost<T>(token: string, url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Google API ${url.split("?")[0]} failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return (await res.json()) as T;
}

function dateRange(): { startDate: string; endDate: string } {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1); // GSC data lags ~1 day
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - RANGE_DAYS);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { startDate: fmt(start), endDate: fmt(end) };
}

/** Hostnames that identify the client's site (website setting + approved origins). */
async function orgSiteHosts(organizationId: string): Promise<string[]> {
  const [org, settings] = await Promise.all([getOrganizationById(organizationId), getOrgSettings(organizationId)]);
  const hosts = new Set<string>();
  for (const candidate of [settings.contact.website, ...(org?.allowedOrigins ?? [])]) {
    if (!candidate || candidate.startsWith("*.")) continue;
    try {
      hosts.add(new URL(candidate.includes("://") ? candidate : `https://${candidate}`).hostname.replace(/^www\./, ""));
    } catch {
      /* skip unparseable entries */
    }
  }
  return [...hosts];
}

type GscSite = { siteUrl: string; permissionLevel: string };

function gscSiteHost(siteUrl: string): string | null {
  if (siteUrl.startsWith("sc-domain:")) return siteUrl.slice("sc-domain:".length).replace(/^www\./, "");
  try {
    return new URL(siteUrl).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

async function pullSearchConsole(organizationId: string): Promise<{ data: Record<string, unknown> } | { error: string }> {
  const token = await getOrgGoogleAccessToken(organizationId);
  const sites = await googleGet<{ siteEntry?: GscSite[] }>(token, "https://searchconsole.googleapis.com/webmasters/v3/sites");
  const entries = (sites.siteEntry ?? []).filter((s) => s.permissionLevel !== "siteUnverifiedUser");
  if (entries.length === 0) return { error: "Your Google account has no verified Search Console properties. Verify your website at search.google.com/search-console first." };

  const hosts = await orgSiteHosts(organizationId);
  const match = entries.find((s) => {
    const host = gscSiteHost(s.siteUrl);
    return !!host && hosts.some((h) => h === host || h.endsWith(`.${host}`));
  });
  const site = match ?? (entries.length === 1 ? entries[0] : null);
  if (!site) {
    return { error: `None of your Search Console properties match your website (${hosts.join(", ") || "no website on file"}). Properties found: ${entries.map((s) => s.siteUrl).join(", ")}.` };
  }

  const range = dateRange();
  const query = (dimension: "page" | "query") =>
    googlePost<{ rows?: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }[] }>(
      token,
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site.siteUrl)}/searchAnalytics/query`,
      { ...range, dimensions: [dimension], rowLimit: ROW_LIMIT },
    );
  const totalsReq = googlePost<{ rows?: { clicks: number; impressions: number }[] }>(
    token,
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site.siteUrl)}/searchAnalytics/query`,
    { ...range, rowLimit: 1 },
  );
  const [byPage, byQuery, totals] = await Promise.all([query("page"), query("query"), totalsReq]);
  const mapRows = (rows?: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }[]) =>
    (rows ?? []).map((r) => ({
      key: r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: Math.round(r.ctr * 1000) / 10,
      position: Math.round(r.position * 10) / 10,
    }));
  return {
    data: {
      site: site.siteUrl,
      matchedAutomatically: !!match,
      range,
      totals: { clicks: totals.rows?.[0]?.clicks ?? 0, impressions: totals.rows?.[0]?.impressions ?? 0 },
      topPages: mapRows(byPage.rows),
      topQueries: mapRows(byQuery.rows),
    },
  };
}

type Ga4Property = { property: string; displayName: string };

async function pullGa4(organizationId: string): Promise<{ data: Record<string, unknown> } | { error: string }> {
  const token = await getOrgGoogleAccessToken(organizationId);
  const summaries = await googleGet<{ accountSummaries?: { propertySummaries?: Ga4Property[] }[] }>(
    token,
    "https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=50",
  );
  const properties = (summaries.accountSummaries ?? []).flatMap((a) => a.propertySummaries ?? []);
  if (properties.length === 0) return { error: "Your Google account has no GA4 properties. Set up Google Analytics 4 for your website first." };
  const property = properties[0];

  const range = dateRange();
  const report = await googlePost<{
    rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[];
    totals?: { metricValues: { value: string }[] }[];
  }>(token, `https://analyticsdata.googleapis.com/v1beta/${property.property}:runReport`, {
    dateRanges: [range],
    dimensions: [{ name: "pagePath" }],
    metrics: [{ name: "sessions" }, { name: "screenPageViews" }],
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: ROW_LIMIT,
    metricAggregations: ["TOTAL"],
  });
  const channels = await googlePost<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }>(
    token,
    `https://analyticsdata.googleapis.com/v1beta/${property.property}:runReport`,
    {
      dateRanges: [range],
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: ROW_LIMIT,
    },
  );
  const totalRow = report.totals?.[0]?.metricValues ?? [];
  return {
    data: {
      property: property.property,
      propertyDisplayName: property.displayName,
      propertyCount: properties.length,
      range,
      totals: { sessions: Number(totalRow[0]?.value ?? 0), pageViews: Number(totalRow[1]?.value ?? 0) },
      topPages: (report.rows ?? []).map((r) => ({
        path: r.dimensionValues[0]?.value ?? "",
        sessions: Number(r.metricValues[0]?.value ?? 0),
        pageViews: Number(r.metricValues[1]?.value ?? 0),
      })),
      channels: (channels.rows ?? []).map((r) => ({
        channel: r.dimensionValues[0]?.value ?? "",
        sessions: Number(r.metricValues[0]?.value ?? 0),
      })),
    },
  };
}

/**
 * Pulls fresh snapshots for every source the org has granted access to.
 * Sources without granted scopes are skipped (their honest state is
 * "not granted", shown by the UI from getAnalyticsAccess — no snapshot row).
 */
export async function refreshAnalyticsSnapshots(organizationId: string): Promise<{ refreshed: AnalyticsSource[] }> {
  const access = await getAnalyticsAccess(organizationId);
  if (!access.googleConnected) return { refreshed: [] };
  const refreshed: AnalyticsSource[] = [];
  if (access.searchConsoleGranted) {
    const result = await pullSearchConsole(organizationId).catch((e: Error) => ({ error: `Search Console pull failed: ${e.message.slice(0, 300)}` }));
    await storeSnapshot(organizationId, "search_console", result);
    refreshed.push("search_console");
  }
  if (access.ga4Granted) {
    const result = await pullGa4(organizationId).catch((e: Error) => ({ error: `Google Analytics pull failed: ${e.message.slice(0, 300)}` }));
    await storeSnapshot(organizationId, "ga4", result);
    refreshed.push("ga4");
  }
  return { refreshed };
}

/** Orgs whose Google connection carries at least one analytics scope — the cron pull set. */
export async function listOrgsWithAnalyticsAccess(limit = 200): Promise<string[]> {
  const { rows } = await getPool().query(
    `SELECT c.organization_id FROM org_calendar_connections c
     JOIN organizations o ON o.id = c.organization_id AND o.status = 'active'
     WHERE c.provider = 'google_calendar'
       AND (c.granted_scopes LIKE '%' || $1 || '%' OR c.granted_scopes LIKE '%' || $2 || '%')
     LIMIT $3`,
    [SEARCH_CONSOLE_SCOPE, GA4_SCOPE, limit],
  );
  return rows.map((r) => r.organization_id);
}
