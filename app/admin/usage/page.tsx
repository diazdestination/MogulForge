import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { isPlatformAdmin } from "@/lib/admin-auth";
import { getAllOrgUsage } from "@/lib/usage";
import { usagePeriodFor, USAGE_METRIC_LABELS, type UsageMetric } from "@/lib/usage-metrics";

export const metadata: Metadata = { title: "Usage — Admin", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const COLUMNS: UsageMetric[] = [
  "leads_stored",
  "leads_imported",
  "leads_analyzed",
  "ai_jobs",
  "messages_generated",
  "sms_sent",
  "emails_sent",
  "api_requests",
  "webhook_events",
  "active_users",
];

function shiftPeriod(period: string, delta: number): string {
  const [year, month] = period.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return usagePeriodFor(date);
}

export default async function AdminUsagePage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  if (!(await isPlatformAdmin())) redirect("/admin/login?next=/admin/usage");
  const { period: periodParam } = await searchParams;
  const currentPeriod = usagePeriodFor(new Date());
  const period = periodParam && /^\d{4}-\d{2}$/.test(periodParam) ? periodParam : currentPeriod;
  const rows = await getAllOrgUsage(period);

  return <section className="shell py-16">
    <div className="mx-auto max-w-7xl">
      <p className="eyebrow"><Link href="/admin/organizations" className="hover:underline">MogulForge Admin</Link> / Usage</p>
      <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl font-semibold">Cross-organization usage</h1>
          <p className="mt-2 text-sm text-white/50">Consumption for every client, per billing period. Warning badges show 75/90/100% limit crossings.</p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Link href={`/admin/usage?period=${shiftPeriod(period, -1)}`} className="btn-secondary">← {shiftPeriod(period, -1)}</Link>
          <span className="rounded-full border border-forge-lime/40 px-4 py-2 font-bold text-forge-lime">{period}</span>
          {period < currentPeriod && <Link href={`/admin/usage?period=${shiftPeriod(period, 1)}`} className="btn-secondary">{shiftPeriod(period, 1)} →</Link>}
        </div>
      </div>

      <div className="mt-8 overflow-x-auto rounded-xl border border-white/10">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-white/10 bg-white/[.03] text-xs uppercase tracking-wider text-white/50">
            <tr>
              <th className="px-4 py-2.5">Organization</th>
              <th className="px-4 py-2.5">Plan</th>
              <th className="px-4 py-2.5">State</th>
              {COLUMNS.map((metric) => <th key={metric} className="px-3 py-2.5 text-right">{USAGE_METRIC_LABELS[metric].replace(" (incl. simulated)", "")}</th>)}
              <th className="px-4 py-2.5">Warnings</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={COLUMNS.length + 4} className="px-4 py-8 text-center text-white/40">No organizations yet.</td></tr>}
            {rows.map((row) => <tr key={row.organizationId} className="border-b border-white/5 last:border-0">
              <td className="px-4 py-2.5 font-semibold"><Link href={`/admin/organizations/${row.organizationId}`} className="hover:text-forge-lime hover:underline">{row.name}</Link></td>
              <td className="px-4 py-2.5 text-white/60">{row.planName}</td>
              <td className="px-4 py-2.5"><span className={row.status === "suspended" || row.status === "cancelled" ? "text-red-400" : row.status === "trialing" ? "text-amber-300" : "text-white/60"}>{row.status}</span></td>
              {COLUMNS.map((metric) => <td key={metric} className="px-3 py-2.5 text-right tabular-nums text-white/70">{row.counts[metric].toLocaleString()}</td>)}
              <td className="px-4 py-2.5">
                {row.warnings.length === 0 && <span className="text-white/30">—</span>}
                <div className="flex flex-wrap gap-1">
                  {row.warnings.map((warning) => <span key={`${warning.metric}-${warning.threshold}`} className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${warning.threshold >= 100 ? "border-red-400/50 text-red-400" : warning.threshold >= 90 ? "border-amber-400/50 text-amber-300" : "border-white/20 text-white/50"}`}>
                    {USAGE_METRIC_LABELS[warning.metric].replace(" (incl. simulated)", "")} {warning.threshold}%
                  </span>)}
                </div>
              </td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </div>
  </section>;
}
