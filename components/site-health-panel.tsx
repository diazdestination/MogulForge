"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

type CrawlPage = { url: string; ok: boolean; httpStatus: number | null; title: string | null; error: string | null; discoveredVia: string };
type Crawl = {
  id: string; rootUrl: string; status: "running" | "complete" | "failed"; error: string | null;
  pageCap: number; pagesFound: number; pagesOk: number; usedSitemap: boolean; startedAt: string; finishedAt: string | null;
};
type Widget = { origin: string; module: string; firstSeenAt: string; lastSeenAt: string; beatCount: number; liveness: "live" | "recent" | "silent" };
type Snapshot = { source: "search_console" | "ga4"; status: "ok" | "error"; error: string | null; data: Record<string, unknown>; capturedAt: string };

type HealthData = {
  status: {
    googleConfigured: boolean;
    google: { connected: boolean; accountEmail: string | null };
    leads: { activeCrmProviders: string[]; hasCrmConnection: boolean; leadCount: number };
    website: { origins: string[]; websiteUrl: string };
    calendar: { syncProvider: string; orgConnected: boolean; workspaceConnected: boolean; calendlyUrl: string };
  };
  crawl: { crawl: Crawl; pages: CrawlPage[] } | null;
  widgets: Widget[];
  neverSeenOrigins: string[];
  analytics: {
    access: { googleConnected: boolean; accountEmail: string | null; searchConsoleGranted: boolean; ga4Granted: boolean };
    analyticsEntitled: boolean;
    snapshots: Snapshot[];
    leads28d: number;
  };
};

const box = "rounded-2xl border border-white/10 bg-white/[0.03] p-6";
const th = "pb-2 text-[10px] uppercase tracking-wider text-white/40";

function timeAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function StatusPill({ tone, label }: { tone: "good" | "warn" | "bad" | "off"; label: string }) {
  const cls = {
    good: "border-forge-lime/40 bg-forge-lime/10 text-forge-lime",
    warn: "border-yellow-400/40 bg-yellow-400/10 text-yellow-300",
    bad: "border-forge-rust/40 bg-forge-rust/10 text-forge-rust",
    off: "border-white/15 bg-white/5 text-white/45",
  }[tone];
  return <span className={`inline-block rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${cls}`}>{label}</span>;
}

export function SiteHealthPanel({ orgId }: { orgId: string }) {
  const [data, setData] = useState<HealthData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/orgs/${orgId}/site-health`, { cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.error ?? "Could not load site health."); return; }
      setData(body);
      setError("");
    } catch {
      setError("Could not load site health.");
    }
  }, [orgId]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  // Poll while a crawl is running so the report fills in live.
  const crawlRunning = data?.crawl?.crawl.status === "running";
  useEffect(() => {
    if (crawlRunning && !pollRef.current) {
      pollRef.current = setInterval(() => { void load(); }, 3000);
    } else if (!crawlRunning && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [crawlRunning, load]);

  const post = useCallback(async (path: string, label: string, okNotice: string) => {
    setBusy(label);
    setNotice("");
    try {
      const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setNotice(body?.error ?? "That didn't work — try again."); return; }
      setNotice(okNotice);
      await load();
    } catch {
      setNotice("That didn't work — try again.");
    } finally {
      setBusy("");
    }
  }, [load]);

  if (error) return <p className="rounded-2xl border border-forge-rust/40 bg-forge-rust/10 p-5 text-sm text-forge-rust">{error}</p>;
  if (!data) return <p className="text-sm text-white/50">Checking your connections…</p>;

  const { status, crawl, widgets, neverSeenOrigins, analytics } = data;
  const liveWidgets = widgets.filter((w) => w.liveness !== "silent");
  const failures = crawl?.pages.filter((p) => !p.ok) ?? [];
  const gsc = analytics.snapshots.find((s) => s.source === "search_console");
  const ga4 = analytics.snapshots.find((s) => s.source === "ga4");
  const settingsHref = `/dashboard/settings?org=${orgId}`;
  const grantHref = `/api/orgs/${orgId}/calendar/oauth/google_calendar?scopes=analytics&returnTo=${encodeURIComponent(`/dashboard/revenue-rescue/site-health?org=${orgId}`)}`;

  const healthCards: { label: string; tone: "good" | "warn" | "bad" | "off"; pill: string; detail: string }[] = [
    {
      label: "Website access",
      tone: crawl ? (crawl.crawl.status === "failed" ? "bad" : failures.length > 0 ? "warn" : "good") : "off",
      pill: crawl ? (crawl.crawl.status === "running" ? "Checking…" : crawl.crawl.status === "failed" ? "Failed" : failures.length > 0 ? `${failures.length} issue${failures.length === 1 ? "" : "s"}` : "All pages OK") : "Not checked",
      detail: crawl ? `We can see ${crawl.crawl.pagesOk} of ${crawl.crawl.pagesFound} pages checked.` : "Run the site check below to prove page access.",
    },
    {
      label: "Widget",
      tone: liveWidgets.length > 0 ? "good" : widgets.length > 0 ? "warn" : status.website.origins.length > 0 ? "bad" : "off",
      pill: liveWidgets.length > 0 ? "Live" : widgets.length > 0 ? "Gone quiet" : status.website.origins.length > 0 ? "Never seen" : "No site yet",
      detail:
        liveWidgets.length > 0
          ? `Active on ${liveWidgets.length} site${liveWidgets.length === 1 ? "" : "s"} — last seen ${timeAgo(widgets[0].lastSeenAt)}.`
          : widgets.length > 0
            ? `Last seen ${timeAgo(widgets[0].lastSeenAt)} on ${widgets[0].origin}.`
            : "No heartbeat from your website yet — is the embed installed?",
    },
    {
      label: "CRM",
      tone: status.leads.activeCrmProviders.length > 0 ? "good" : status.leads.hasCrmConnection ? "warn" : "off",
      pill: status.leads.activeCrmProviders.length > 0 ? "Connected" : status.leads.hasCrmConnection ? "Setup started" : "Not connected",
      detail: status.leads.activeCrmProviders.length > 0 ? `Active: ${status.leads.activeCrmProviders.join(", ")} · ${status.leads.leadCount.toLocaleString()} leads on file.` : `${status.leads.leadCount.toLocaleString()} leads on file.`,
    },
    {
      label: "Calendar",
      tone: status.calendar.orgConnected ? "good" : status.calendar.workspaceConnected ? "warn" : "off",
      pill: status.calendar.orgConnected ? "Your account" : status.calendar.workspaceConnected ? "Shared fallback" : "Not connected",
      detail: status.calendar.orgConnected ? "Bookings sync to your own calendar." : status.calendar.workspaceConnected ? "Using the workspace fallback calendar." : "Connect a calendar so bookings sync.",
    },
    {
      label: "Google account",
      tone: analytics.access.googleConnected ? "good" : status.googleConfigured ? "off" : "warn",
      pill: analytics.access.googleConnected ? "Connected" : status.googleConfigured ? "Not connected" : "Unavailable",
      detail: analytics.access.googleConnected
        ? (analytics.access.accountEmail ?? "Connected.")
        : status.googleConfigured
          ? "Sign in with Google from Settings → Connections."
          : "Google sign-in isn't configured on the platform yet.",
    },
    {
      label: "Lead-gen analytics",
      tone: analytics.access.searchConsoleGranted || analytics.access.ga4Granted ? "good" : "off",
      pill: analytics.access.searchConsoleGranted || analytics.access.ga4Granted ? "Access granted" : "Not granted",
      detail: analytics.access.searchConsoleGranted || analytics.access.ga4Granted
        ? [analytics.access.searchConsoleGranted ? "Search Console" : null, analytics.access.ga4Granted ? "Google Analytics" : null].filter(Boolean).join(" + ") + " (read-only)."
        : "Grant read-only access to see what drives your leads.",
    },
  ];

  return (
    <div className="space-y-6">
      {notice && <p className="rounded-2xl border border-white/15 bg-white/5 p-4 text-sm text-white/70">{notice}</p>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {healthCards.map((c) => (
          <div key={c.label} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-bold uppercase tracking-wider text-white/45">{c.label}</p>
              <StatusPill tone={c.tone} label={c.pill} />
            </div>
            <p className="mt-3 text-xs text-white/55">{c.detail}</p>
          </div>
        ))}
      </div>

      {/* Whole-site access check */}
      <div className={box}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-xl font-semibold">Site access check</h2>
            <p className="mt-1 text-xs text-white/45">
              We politely crawl your website (sitemap first, then internal links) and report exactly which pages we can reach.
            </p>
          </div>
          <button
            type="button"
            className="btn-secondary px-4 py-2 text-xs"
            disabled={busy === "crawl" || crawlRunning}
            onClick={() => void post(`/api/orgs/${orgId}/site-health/crawl`, "crawl", "Site check started — results fill in below.")}
          >
            {crawlRunning ? "Checking…" : crawl ? "Re-run check" : "Run check"}
          </button>
        </div>

        {!crawl && (
          <p className="mt-4 text-sm text-white/50">
            {status.website.websiteUrl
              ? <>No check yet. We&apos;ll crawl <span className="text-white/80">{status.website.websiteUrl}</span>.</>
              : <>Add your website in <Link href={settingsHref} className="underline hover:text-forge-lime">Settings</Link> first, then run the check.</>}
          </p>
        )}

        {crawl && (
          <div className="mt-5 space-y-4">
            <p className="text-sm">
              <span className="font-display text-2xl font-semibold">{crawl.crawl.pagesOk}</span>
              <span className="text-white/55"> of </span>
              <span className="font-display text-2xl font-semibold">{crawl.crawl.pagesFound}</span>
              <span className="text-white/55"> pages reachable on {crawl.crawl.rootUrl}</span>
              {crawl.crawl.status === "running" && <span className="ml-2 text-xs text-yellow-300">still checking…</span>}
            </p>
            <p className="text-xs text-white/45">
              {crawl.crawl.usedSitemap ? "Pages discovered from your sitemap and links" : "No sitemap found — pages discovered by following links"} · capped at {crawl.crawl.pageCap} pages · started {timeAgo(crawl.crawl.startedAt)}
            </p>
            {crawl.crawl.status === "failed" && (
              <p className="rounded-xl border border-forge-rust/40 bg-forge-rust/10 p-4 text-sm text-forge-rust">{crawl.crawl.error ?? "The check failed."}</p>
            )}
            {failures.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-xs">
                  <thead><tr><th className={th}>Page we couldn&apos;t reach</th><th className={th}>Problem</th><th className={`${th} text-right`}>Found via</th></tr></thead>
                  <tbody className="divide-y divide-white/5">
                    {failures.map((p) => (
                      <tr key={p.url}>
                        <td className="max-w-[340px] truncate py-2 pr-3" title={p.url}>{p.url}</td>
                        <td className="py-2 pr-3 text-white/60">{p.error ?? `HTTP ${p.httpStatus}`}</td>
                        <td className="py-2 text-right text-white/40">{p.discoveredVia}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {crawl.crawl.status === "complete" && failures.length === 0 && (
              <p className="text-sm text-forge-lime">Every page we checked is reachable. Your site is fully visible to our agents.</p>
            )}
          </div>
        )}
      </div>

      {/* Widget liveness */}
      <div className={box}>
        <h2 className="font-display text-xl font-semibold">Widget liveness</h2>
        <p className="mt-1 text-xs text-white/45">Your embedded widgets ping us while they&apos;re open on a visitor&apos;s screen. This is proof they&apos;re actually installed and running.</p>
        {widgets.length === 0 ? (
          <p className="mt-4 text-sm text-white/50">
            No heartbeats yet. {status.website.origins.length > 0 ? "The embed hasn't loaded on your site — check the install snippet in " : "Approve your website origin and install the embed from "}
            <Link href={settingsHref} className="underline hover:text-forge-lime">Settings</Link>.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-xs">
              <thead><tr><th className={th}>Site</th><th className={th}>Widget</th><th className={th}>Status</th><th className={th}>Last seen</th><th className={`${th} text-right`}>Loads</th></tr></thead>
              <tbody className="divide-y divide-white/5">
                {widgets.map((w) => (
                  <tr key={`${w.origin}-${w.module}`}>
                    <td className="py-2 pr-3 font-semibold">{w.origin}</td>
                    <td className="py-2 pr-3 text-white/60">{w.module.replace("_", " ")}</td>
                    <td className="py-2 pr-3">
                      <StatusPill tone={w.liveness === "live" ? "good" : w.liveness === "recent" ? "warn" : "bad"} label={w.liveness === "live" ? "Live now" : w.liveness === "recent" ? "Seen today" : "Gone quiet"} />
                    </td>
                    <td className="py-2 pr-3 text-white/60">{timeAgo(w.lastSeenAt)}</td>
                    <td className="py-2 text-right text-white/60">{w.beatCount.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {neverSeenOrigins.length > 0 && widgets.length > 0 && (
          <p className="mt-3 text-xs text-yellow-300">Approved but never seen: {neverSeenOrigins.join(", ")} — the widget may not be installed there.</p>
        )}
      </div>

      {/* Lead-gen analytics */}
      <div className={box}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-xl font-semibold">What&apos;s driving leads</h2>
            <p className="mt-1 text-xs text-white/45">Read-only Google Search Console + Analytics, matched against the {analytics.leads28d.toLocaleString()} lead{analytics.leads28d === 1 ? "" : "s"} you got in the last 28 days.</p>
          </div>
          {(analytics.access.searchConsoleGranted || analytics.access.ga4Granted) && analytics.analyticsEntitled && (
            <button
              type="button"
              className="btn-secondary px-4 py-2 text-xs"
              disabled={busy === "analytics"}
              onClick={() => void post(`/api/orgs/${orgId}/site-health/analytics`, "analytics", "Fresh numbers pulled from Google.")}
            >
              {busy === "analytics" ? "Refreshing…" : "Refresh now"}
            </button>
          )}
        </div>

        {!analytics.access.googleConnected ? (
          <p className="mt-4 text-sm text-white/50">
            {status.googleConfigured
              ? <>Not connected. Sign in with Google from <Link href={settingsHref} className="underline hover:text-forge-lime">Settings → Connections</Link>, then grant analytics access here.</>
              : <>Google sign-in isn&apos;t available on the platform yet, so analytics can&apos;t be connected. This will light up once it&apos;s configured.</>}
          </p>
        ) : !analytics.access.searchConsoleGranted && !analytics.access.ga4Granted ? (
          <div className="mt-4 space-y-3">
            <p className="text-sm text-white/50">Your Google account is connected ({analytics.access.accountEmail ?? "unknown"}), but we don&apos;t have analytics access yet. Granting it is read-only — we can never change anything.</p>
            <a href={grantHref} className="btn-primary inline-block px-5 py-2.5 text-xs">Grant analytics access</a>
          </div>
        ) : !analytics.analyticsEntitled ? (
          <p className="mt-4 text-sm text-white/50">Analytics isn&apos;t included in your current plan. Contact support to enable it.</p>
        ) : (
          <div className="mt-5 grid gap-6 lg:grid-cols-2">
            <SnapshotCard title="Search — what people look for" snap={gsc} granted={analytics.access.searchConsoleGranted} kind="gsc" />
            <SnapshotCard title="Traffic — where visits come from" snap={ga4} granted={analytics.access.ga4Granted} kind="ga4" />
          </div>
        )}
      </div>
    </div>
  );
}

function SnapshotCard({ title, snap, granted, kind }: { title: string; snap: Snapshot | undefined; granted: boolean; kind: "gsc" | "ga4" }) {
  if (!granted) return <div><h3 className="text-sm font-semibold">{title}</h3><p className="mt-2 text-xs text-white/45">Access not granted for this source.</p></div>;
  if (!snap) return <div><h3 className="text-sm font-semibold">{title}</h3><p className="mt-2 text-xs text-white/45">No data pulled yet — hit &ldquo;Refresh now&rdquo;.</p></div>;
  if (snap.status === "error") {
    return (
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-2 rounded-xl border border-yellow-400/30 bg-yellow-400/5 p-3 text-xs text-yellow-200">{snap.error}</p>
      </div>
    );
  }
  const d = snap.data as {
    site?: string; propertyDisplayName?: string;
    totals?: { clicks?: number; impressions?: number; sessions?: number };
    topPages?: { key?: string; path?: string; clicks?: number; sessions?: number }[];
    topQueries?: { key: string; clicks: number }[];
    channels?: { channel: string; sessions: number }[];
  };
  if (kind === "gsc") {
    const pages = d.topPages ?? [];
    const queries = d.topQueries ?? [];
    return (
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-1 text-xs text-white/45">{d.site} · {(d.totals?.clicks ?? 0).toLocaleString()} clicks / {(d.totals?.impressions ?? 0).toLocaleString()} views in Google · updated {timeAgoStatic(snap.capturedAt)}</p>
        <MiniTable label="Top pages bringing visitors" rows={pages.map((r) => ({ key: r.key ?? "", value: `${r.clicks ?? 0} clicks` }))} empty="No search clicks recorded yet." />
        <MiniTable label="Top searches" rows={queries.map((r) => ({ key: r.key, value: `${r.clicks} clicks` }))} empty="No search queries recorded yet." />
      </div>
    );
  }
  const pages = d.topPages ?? [];
  const channels = d.channels ?? [];
  return (
    <div>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-xs text-white/45">{d.propertyDisplayName} · {(d.totals?.sessions ?? 0).toLocaleString()} visits in 28 days · updated {timeAgoStatic(snap.capturedAt)}</p>
      <MiniTable label="Most-visited pages" rows={pages.map((r) => ({ key: r.path ?? "", value: `${r.sessions ?? 0} visits` }))} empty="No traffic recorded yet." />
      <MiniTable label="Where visits come from" rows={channels.map((r) => ({ key: r.channel, value: `${r.sessions} visits` }))} empty="No channel data yet." />
    </div>
  );
}

function MiniTable({ label, rows, empty }: { label: string; rows: { key: string; value: string }[]; empty: string }) {
  return (
    <div className="mt-4">
      <p className="text-[10px] font-bold uppercase tracking-wider text-white/40">{label}</p>
      {rows.length === 0 ? (
        <p className="mt-2 text-xs text-white/45">{empty}</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {rows.slice(0, 5).map((r) => (
            <li key={r.key} className="flex items-baseline justify-between gap-3 text-xs">
              <span className="min-w-0 truncate text-white/70" title={r.key}>{r.key}</span>
              <span className="shrink-0 font-semibold">{r.value}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function timeAgoStatic(iso: string): string {
  const hours = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 3600000));
  if (hours < 1) return "just now";
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.round(hours / 24)} days ago`;
}
