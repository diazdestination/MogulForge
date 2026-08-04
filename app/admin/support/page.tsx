import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { isPlatformAdmin } from "@/lib/admin-auth";
import { getOrganizationById, listEntitlements, listInvites, listMembers, searchOrganizations, isInviteActive } from "@/lib/tenant";
import { listAuditLogs } from "@/lib/audit";
import { PLAN_LABELS } from "@/lib/plans";
import { FEATURE_LABELS } from "@/lib/entitlements";

export const metadata: Metadata = { title: "Support console — Admin", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const statusStyles: Record<string, string> = {
  active: "border-forge-lime/40 text-forge-lime",
  paused: "border-yellow-400/40 text-yellow-300",
  cancelled: "border-red-400/40 text-red-300",
};

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", { dateStyle: "medium" });
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

export default async function AdminSupportPage({ searchParams }: { searchParams: Promise<{ q?: string; org?: string }> }) {
  if (!(await isPlatformAdmin())) redirect("/admin/login?next=/admin/support");
  const params = await searchParams;
  const q = (params.q ?? "").trim();
  const results = q ? await searchOrganizations(q) : [];
  // Auto-select when the search narrows to a single org.
  const selectedOrgId = params.org || (results.length === 1 ? results[0].id : "");
  const org = selectedOrgId ? await getOrganizationById(selectedOrgId) : null;
  const [members, entitlements, invites, auditLogs] = org
    ? await Promise.all([
        listMembers(org.id),
        listEntitlements(org.id),
        listInvites(org.id),
        listAuditLogs({ organizationId: org.id, limit: 25 }),
      ])
    : [[], [], [], []];
  const pendingInvites = invites.filter(isInviteActive);
  const enabledModules = entitlements.filter((e) => e.enabled);

  return <section className="shell py-16">
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow"><Link href="/admin/organizations" className="hover:underline">MogulForge Admin</Link> / Support</p>
          <h1 className="mt-4 font-display text-4xl font-semibold">Support console</h1>
          <p className="mt-2 text-sm text-white/50">Look up any client organization by name, slug, or member email.</p>
        </div>
        <div className="flex gap-3">
          <Link href="/admin/organizations" className="btn-secondary">Organizations</Link>
          <Link href="/admin/subscriptions" className="btn-secondary">Subscriptions</Link>
          <Link href="/admin/usage" className="btn-secondary">Usage</Link>
          <Link href="/admin/audit-logs" className="btn-secondary">Audit logs</Link>
        </div>
      </div>

      <form method="GET" className="mt-8 flex flex-wrap items-center gap-2">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search by org name, slug, or member email…"
          className="w-full max-w-md rounded-xl border border-white/10 bg-white/[.04] px-4 py-2.5 text-sm outline-none focus:border-forge-lime/50"
        />
        <button type="submit" className="btn-primary">Search</button>
        {q && <Link href="/admin/support" className="btn-secondary">Clear</Link>}
      </form>

      {q && <div className="mt-6">
        <p className="text-sm text-white/50">{results.length} match{results.length === 1 ? "" : "es"} for “{q}”</p>
        {results.length > 0 && <div className="mt-3 overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-white/10 bg-white/[.03] text-xs uppercase tracking-wider text-white/50">
              <tr>
                <th className="px-4 py-3">Organization</th>
                <th className="px-4 py-3">Plan</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Members</th>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => <tr key={r.id} className={`border-b border-white/5 last:border-0 ${r.id === selectedOrgId ? "bg-white/[.04]" : ""}`}>
                <td className="px-4 py-3"><Link href={`/admin/organizations/${r.id}`} className="font-semibold text-forge-lime hover:underline">{r.name}</Link><span className="ml-2 text-xs text-white/40">{r.slug}</span></td>
                <td className="px-4 py-3">{PLAN_LABELS[r.plan]}</td>
                <td className="px-4 py-3"><span className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${statusStyles[r.status] ?? "border-white/20 text-white/60"}`}>{r.status}</span></td>
                <td className="px-4 py-3">{r.memberCount}</td>
                <td className="whitespace-nowrap px-4 py-3 text-white/60">{formatDate(r.createdAt)}</td>
                <td className="px-4 py-3 text-right">
                  {r.id === selectedOrgId
                    ? <span className="text-xs text-white/40">Shown below</span>
                    : <Link href={`/admin/support?q=${encodeURIComponent(q)}&org=${r.id}`} className="text-xs font-semibold text-forge-lime hover:underline">View snapshot</Link>}
                </td>
              </tr>)}
            </tbody>
          </table>
        </div>}
      </div>}

      {org && <div className="mt-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-2xl font-semibold">{org.name} <span className="ml-2 text-sm font-normal text-white/40">{org.slug}</span></h2>
            <p className="mt-1 text-sm text-white/50">
              {PLAN_LABELS[org.plan]} plan
              <span className={`ml-3 rounded-full border px-2.5 py-0.5 text-xs font-bold ${statusStyles[org.status] ?? "border-white/20 text-white/60"}`}>{org.status}</span>
              <span className="ml-3">Created {formatDate(org.createdAt)}</span>
            </p>
          </div>
          <Link href={`/admin/organizations/${org.id}`} className="btn-primary">Open org detail</Link>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <div className="rounded-xl border border-white/10 p-5">
            <h3 className="text-xs font-bold uppercase tracking-wider text-white/50">Members ({members.length})</h3>
            {members.length === 0 && <p className="mt-3 text-sm text-white/40">No members.</p>}
            <ul className="mt-3 space-y-2 text-sm">
              {members.map((m) => <li key={m.membershipId} className="flex items-center justify-between gap-3">
                <span><span className="font-semibold">{m.name}</span> <span className="text-white/50">{m.email}</span></span>
                <span className="rounded-full border border-white/20 px-2.5 py-0.5 text-xs text-white/60">{m.role}</span>
              </li>)}
            </ul>
          </div>

          <div className="rounded-xl border border-white/10 p-5">
            <h3 className="text-xs font-bold uppercase tracking-wider text-white/50">Enabled modules ({enabledModules.length})</h3>
            {enabledModules.length === 0 && <p className="mt-3 text-sm text-white/40">No modules enabled.</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              {enabledModules.map((e) => <span key={e.featureKey} className="rounded-full border border-forge-lime/40 px-3 py-1 text-xs font-semibold text-forge-lime">{FEATURE_LABELS[e.featureKey]}</span>)}
            </div>
          </div>

          <div className="rounded-xl border border-white/10 p-5">
            <h3 className="text-xs font-bold uppercase tracking-wider text-white/50">Pending invites ({pendingInvites.length})</h3>
            {pendingInvites.length === 0 && <p className="mt-3 text-sm text-white/40">No pending invites.</p>}
            <ul className="mt-3 space-y-2 text-sm">
              {pendingInvites.map((i) => <li key={i.id} className="flex items-center justify-between gap-3">
                <span>{i.email}{i.name ? <span className="ml-2 text-white/50">{i.name}</span> : null}</span>
                <span className="whitespace-nowrap text-xs text-white/40">{i.role} · expires {formatDate(i.expiresAt)}</span>
              </li>)}
            </ul>
          </div>

          <div className="rounded-xl border border-white/10 p-5">
            <h3 className="text-xs font-bold uppercase tracking-wider text-white/50">Contact & support</h3>
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between gap-3"><dt className="text-white/50">Support email</dt><dd>{org.supportEmail ?? "—"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-white/50">Support phone</dt><dd>{org.supportPhone ?? "—"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-white/50">Industry</dt><dd>{org.industry ?? "—"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-white/50">Timezone</dt><dd>{org.timezone}</dd></div>
            </dl>
          </div>
        </div>

        <div className="mt-6 rounded-xl border border-white/10">
          <div className="flex items-center justify-between px-5 py-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-white/50">Recent audit activity</h3>
            <Link href={`/admin/audit-logs?org=${org.id}`} className="text-xs font-semibold text-forge-lime hover:underline">Full audit log</Link>
          </div>
          {auditLogs.length === 0 && <p className="px-5 pb-5 text-sm text-white/40">No audit entries yet.</p>}
          {auditLogs.length > 0 && <div className="overflow-x-auto border-t border-white/10">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-white/10 bg-white/[.03] text-xs uppercase tracking-wider text-white/50">
                <tr>
                  <th className="px-4 py-3">Time</th>
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Actor</th>
                  <th className="px-4 py-3">Target</th>
                </tr>
              </thead>
              <tbody>
                {auditLogs.map((log) => <tr key={log.id} className="border-b border-white/5 last:border-0">
                  <td className="whitespace-nowrap px-4 py-3 text-white/60">{formatDateTime(log.createdAt)}</td>
                  <td className="px-4 py-3 font-semibold">{log.action}</td>
                  <td className="px-4 py-3 text-white/60">{log.actorLabel}</td>
                  <td className="px-4 py-3 text-white/60">{log.targetType ? `${log.targetType}${log.targetId ? ` · ${log.targetId}` : ""}` : "—"}</td>
                </tr>)}
              </tbody>
            </table>
          </div>}
        </div>
      </div>}

      {!q && !org && <p className="mt-10 rounded-xl border border-white/10 bg-white/[.02] p-8 text-center text-sm text-white/40">
        Search for an organization above to see its members, plan, modules, pending invites, and recent activity.
      </p>}
    </div>
  </section>;
}
