import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { isPlatformAdmin } from "@/lib/admin-auth";
import { readJobHeartbeats, readSchedulerHealth, STALE_AFTER_MINUTES, type JobHeartbeat, type SchedulerHealth } from "@/lib/cron-heartbeat";
import { readBotTrapStats, type BotTrapStats } from "@/lib/bot-trap-metrics";
import { listOrganizations } from "@/lib/tenant";
import { PLAN_LABELS } from "@/lib/plans";

export const metadata: Metadata = { title: "Organizations — Admin", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const statusStyles: Record<string, string> = {
  active: "border-forge-lime/40 text-forge-lime",
  paused: "border-yellow-400/40 text-yellow-300",
  cancelled: "border-red-400/40 text-red-300",
};

function SchedulerWarning({ health }: { health: SchedulerHealth }) {
  if (!health.stale) return null;
  const detail = health.hasHeartbeat
    ? `Last successful cron hit was ${health.minutesSinceLast} minute${health.minutesSinceLast === 1 ? "" : "s"} ago (expected at least every ${STALE_AFTER_MINUTES}).`
    : "No external cron hit has ever been recorded.";
  return <div className="mb-8 rounded-xl border border-red-400/40 bg-red-500/10 px-5 py-4 text-sm text-red-200">
    <p className="font-bold">Background job scheduler looks stopped</p>
    <p className="mt-1 text-red-200/80">{detail} Webhook retries and the weekly lead digest depend on the external scheduler. Check that the scheduled deployment running <code className="rounded bg-white/10 px-1">scripts/cron/trigger.mjs</code> still exists and its CRON_SECRET matches the app&apos;s.</p>
  </div>;
}

function formatAgo(minutes: number): string {
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} days ago`;
}

function JobStatusCard({ jobs }: { jobs: JobHeartbeat[] }) {
  if (jobs.length === 0) return null;
  return <div className="mb-8 rounded-xl border border-white/10 bg-white/[.03] px-5 py-4">
    <div className="flex items-baseline justify-between gap-4">
      <p className="text-xs font-bold uppercase tracking-wider text-white/50">Background jobs</p>
      <p className="text-xs text-white/40">Expected at least every {STALE_AFTER_MINUTES} min via the external scheduler</p>
    </div>
    <ul className="mt-3 grid gap-2 sm:grid-cols-2">
      {jobs.map((job) => <li key={job.job} className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${job.stale ? "border-red-400/40 bg-red-500/10" : "border-white/10"}`}>
        <span className="flex items-center gap-2 font-mono text-xs">
          <span aria-hidden className={`h-2 w-2 rounded-full ${job.stale ? "bg-red-400" : "bg-forge-lime"}`} />
          <span className={job.stale ? "text-red-200" : "text-white/80"}>{job.job}</span>
        </span>
        <span className={`whitespace-nowrap text-xs ${job.stale ? "font-bold text-red-300" : "text-white/50"}`} title={job.lastSuccessAt ? job.lastSuccessAt.toISOString() : undefined}>
          {job.lastSuccessAt ? `Last run ${formatAgo(job.minutesSinceLast ?? 0)}` : "Never run"}
        </span>
      </li>)}
    </ul>
  </div>;
}

const TRAP_REASON_LABELS: Record<string, string> = {
  honeypot: "Honeypot filled",
  missing_elapsed: "No timer value",
  too_fast: "Submitted too fast",
};

function BotTrapCard({ stats }: { stats: BotTrapStats | null }) {
  if (!stats) return null;
  const baseline = stats.baselinePerDay >= 10 ? Math.round(stats.baselinePerDay) : Math.round(stats.baselinePerDay * 10) / 10;
  return <div className={`mb-8 rounded-xl border px-5 py-4 ${stats.spike ? "border-red-400/40 bg-red-500/10" : "border-white/10 bg-white/[.03]"}`}>
    <div className="flex items-baseline justify-between gap-4">
      <p className={`text-xs font-bold uppercase tracking-wider ${stats.spike ? "text-red-300" : "text-white/50"}`}>Scan-form bot trap</p>
      <p className="text-xs text-white/40">7-day baseline: {baseline} hit{baseline === 1 ? "" : "s"}/day</p>
    </div>
    {stats.spike && <p className="mt-2 text-sm font-bold text-red-200">
      Unusual spike: {stats.last24hTotal} hits in the last 24 hours vs. a baseline of {baseline}/day. A browser extension or autofill pattern may be tripping the trap for real visitors — review the reasons below.
    </p>}
    <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-2 text-sm">
      <span className={stats.spike ? "font-bold text-red-200" : "text-white/80"}>
        {stats.last24hTotal} hit{stats.last24hTotal === 1 ? "" : "s"} in the last 24h
      </span>
      {(["honeypot", "missing_elapsed", "too_fast"] as const).map((reason) => <span key={reason} className="text-xs text-white/50">
        {TRAP_REASON_LABELS[reason]}: <span className="font-mono text-white/70">{stats.last24h[reason]}</span>
      </span>)}
    </div>
  </div>;
}

export default async function AdminOrganizationsPage() {
  if (!(await isPlatformAdmin())) redirect("/admin/login?next=/admin/organizations");
  const [organizations, schedulerHealth, jobHeartbeats, botTrapStats] = await Promise.all([
    listOrganizations(),
    readSchedulerHealth().catch((error): SchedulerHealth => {
      console.error("Failed to read scheduler health", error);
      return { hasHeartbeat: true, lastSuccessAt: null, minutesSinceLast: 0, stale: false };
    }),
    readJobHeartbeats().catch((error): JobHeartbeat[] => {
      console.error("Failed to read job heartbeats", error);
      return [];
    }),
    readBotTrapStats().catch((error): null => {
      console.error("Failed to read bot-trap stats", error);
      return null;
    }),
  ]);
  return <section className="shell py-16">
    <div className="mx-auto max-w-5xl">
      <SchedulerWarning health={schedulerHealth} />
      <JobStatusCard jobs={jobHeartbeats} />
      <BotTrapCard stats={botTrapStats} />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">MogulForge Admin</p>
          <h1 className="mt-4 font-display text-4xl font-semibold">Client organizations</h1>
          <p className="mt-2 text-sm text-white/50">{organizations.length} organization{organizations.length === 1 ? "" : "s"}</p>
        </div>
        <div className="flex gap-3">
          <Link href="/admin/support" className="btn-secondary">Support</Link>
          <Link href="/admin/subscriptions" className="btn-secondary">Subscriptions</Link>
          <Link href="/admin/usage" className="btn-secondary">Usage</Link>
          <Link href="/admin/audit-logs" className="btn-secondary">Audit logs</Link>
          <Link href="/admin/leads" className="btn-secondary">Scan leads</Link>
          <Link href="/admin/provision-client" className="btn-primary">Provision new client</Link>
        </div>
      </div>
      <div className="mt-8 overflow-x-auto rounded-xl border border-white/10">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-white/10 bg-white/[.03] text-xs uppercase tracking-wider text-white/50">
            <tr>
              <th className="px-4 py-3">Organization</th>
              <th className="px-4 py-3">Industry</th>
              <th className="px-4 py-3">Plan</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Members</th>
              <th className="px-4 py-3">Created</th>
            </tr>
          </thead>
          <tbody>
            {organizations.length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-white/40">No client organizations yet. Provision your first one.</td></tr>}
            {organizations.map((org) => <tr key={org.id} className="border-b border-white/5 last:border-0">
              <td className="px-4 py-3"><Link href={`/admin/organizations/${org.id}`} className="font-semibold text-forge-lime hover:underline">{org.name}</Link><span className="ml-2 text-xs text-white/40">{org.slug}</span></td>
              <td className="px-4 py-3 text-white/60">{org.industry ?? "—"}</td>
              <td className="px-4 py-3">{PLAN_LABELS[org.plan]}</td>
              <td className="px-4 py-3"><span className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${statusStyles[org.status] ?? "border-white/20 text-white/60"}`}>{org.status}</span></td>
              <td className="px-4 py-3">{org.memberCount}</td>
              <td className="whitespace-nowrap px-4 py-3 text-white/60">{new Date(org.createdAt).toLocaleDateString("en-US", { dateStyle: "medium" })}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </div>
  </section>;
}
