import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { isPlatformAdmin } from "@/lib/admin-auth";
import { listAuditLogs } from "@/lib/audit";
import { listOrganizations } from "@/lib/tenant";

export const metadata: Metadata = { title: "Audit logs — Admin", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function AuditLogsPage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  if (!(await isPlatformAdmin())) redirect("/admin/login?next=/admin/audit-logs");
  const { org } = await searchParams;
  const [logs, organizations] = await Promise.all([
    listAuditLogs({ organizationId: org || undefined, limit: 200 }),
    listOrganizations(),
  ]);
  return <section className="shell py-16">
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow"><Link href="/admin/organizations" className="hover:underline">MogulForge Admin</Link></p>
          <h1 className="mt-4 font-display text-4xl font-semibold">Audit logs</h1>
          <p className="mt-2 text-sm text-white/50">Latest {logs.length} events{org ? " for the selected organization" : ""}.</p>
        </div>
        <form method="GET" className="flex items-center gap-2">
          <select name="org" defaultValue={org ?? ""} className="rounded-xl border border-white/10 bg-white/[.04] px-3 py-2.5 text-sm outline-none focus:border-forge-lime/50">
            <option value="">All organizations</option>
            {organizations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          <button type="submit" className="btn-secondary">Filter</button>
        </form>
      </div>
      <div className="mt-8 overflow-x-auto rounded-xl border border-white/10">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-white/10 bg-white/[.03] text-xs uppercase tracking-wider text-white/50">
            <tr>
              <th className="px-4 py-3">Time</th>
              <th className="px-4 py-3">Action</th>
              <th className="px-4 py-3">Actor</th>
              <th className="px-4 py-3">Organization</th>
              <th className="px-4 py-3">Target</th>
              <th className="px-4 py-3">Details</th>
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-white/40">No audit events yet.</td></tr>}
            {logs.map((log) => <tr key={log.id} className="border-b border-white/5 align-top last:border-0">
              <td className="whitespace-nowrap px-4 py-3 text-white/60">{new Date(log.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</td>
              <td className="px-4 py-3"><span className="rounded-full border border-white/15 px-2.5 py-0.5 text-xs font-bold">{log.action}</span></td>
              <td className="max-w-[14rem] truncate px-4 py-3">{log.actorLabel}</td>
              <td className="max-w-[12rem] truncate px-4 py-3 text-white/60">{log.organizationName ?? "—"}</td>
              <td className="max-w-[12rem] truncate px-4 py-3 text-white/60">{log.targetType ? `${log.targetType}: ${log.targetId ?? ""}` : "—"}</td>
              <td className="max-w-[16rem] truncate px-4 py-3 text-xs text-white/40">{Object.keys(log.metadata).length > 0 ? JSON.stringify(log.metadata) : "—"}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </div>
  </section>;
}
