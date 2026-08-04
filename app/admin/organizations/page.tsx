import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { isPlatformAdmin } from "@/lib/admin-auth";
import { readSchedulerHealth, STALE_AFTER_MINUTES, type SchedulerHealth } from "@/lib/cron-heartbeat";
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

export default async function AdminOrganizationsPage() {
  if (!(await isPlatformAdmin())) redirect("/admin/login?next=/admin/organizations");
  const [organizations, schedulerHealth] = await Promise.all([
    listOrganizations(),
    readSchedulerHealth().catch((error): SchedulerHealth => {
      console.error("Failed to read scheduler health", error);
      return { hasHeartbeat: true, lastSuccessAt: null, minutesSinceLast: 0, stale: false };
    }),
  ]);
  return <section className="shell py-16">
    <div className="mx-auto max-w-5xl">
      <SchedulerWarning health={schedulerHealth} />
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
