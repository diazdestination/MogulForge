import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getPool } from "@/lib/db";
import { checkPassword, createAdminSession, destroyAdminSession, isAdmin } from "@/lib/admin-auth";

export const metadata: Metadata = { title: "Leads — Admin", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

type LeadStatus = "new" | "contacted" | "dismissed";
type Lead = { id: string; url: string; email: string; score: number; created_at: string; status: LeadStatus };

const STATUS_STYLES: Record<LeadStatus, string> = {
  new: "border-forge-lime/40 bg-forge-lime/10 text-forge-lime",
  contacted: "border-sky-400/40 bg-sky-400/10 text-sky-300",
  dismissed: "border-white/15 bg-white/[.06] text-white/50",
};
const STATUS_LABELS: Record<LeadStatus, string> = { new: "New", contacted: "Contacted", dismissed: "Dismissed" };

async function loginAction(formData: FormData) {
  "use server";
  const password = String(formData.get("password") ?? "");
  if (!checkPassword(password)) redirect("/admin/leads?error=1");
  await createAdminSession();
  redirect("/admin/leads");
}

async function logoutAction() {
  "use server";
  await destroyAdminSession();
  redirect("/admin/leads");
}

async function setStatusAction(formData: FormData) {
  "use server";
  if (!(await isAdmin())) redirect("/admin/leads");
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!id || !["new", "contacted", "dismissed"].includes(status)) redirect("/admin/leads");
  await getPool().query("UPDATE visibility_reports SET status = $1 WHERE id = $2", [status, id]);
  revalidatePath("/admin/leads");
}

async function getLeads(status?: LeadStatus): Promise<Lead[]> {
  if (status) {
    const { rows } = await getPool().query(
      "SELECT id, url, email, score, created_at, status FROM visibility_reports WHERE status = $1 ORDER BY created_at DESC LIMIT 500",
      [status],
    );
    return rows;
  }
  const { rows } = await getPool().query(
    "SELECT id, url, email, score, created_at, status FROM visibility_reports ORDER BY created_at DESC LIMIT 500",
  );
  return rows;
}

async function getStatusCounts(): Promise<Record<string, number>> {
  const { rows } = await getPool().query("SELECT status, count(*)::int AS count FROM visibility_reports GROUP BY status");
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}

const FILTERS = [
  { value: "", label: "All" },
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "dismissed", label: "Dismissed" },
] as const;

export default async function AdminLeadsPage({ searchParams }: { searchParams: Promise<{ error?: string; status?: string }> }) {
  if (!(await isAdmin())) {
    const { error } = await searchParams;
    return <section className="shell py-24">
      <div className="mx-auto max-w-sm">
        <p className="eyebrow">Admin</p>
        <h1 className="mt-4 font-display text-4xl font-semibold">Leads dashboard</h1>
        <form action={loginAction} className="mt-8 space-y-4">
          <input type="password" name="password" required placeholder="Admin password" autoFocus className="w-full rounded-xl border border-white/10 bg-white/[.04] px-4 py-3 outline-none focus:border-forge-lime/50" />
          {error && <p className="text-sm text-red-400">Wrong password. Try again.</p>}
          <button type="submit" className="btn-secondary w-full">Sign in</button>
        </form>
      </div>
    </section>;
  }

  const { status: statusParam } = await searchParams;
  const activeStatus = (["new", "contacted", "dismissed"] as const).find((s) => s === statusParam);
  const [leads, statusCounts] = await Promise.all([getLeads(activeStatus), getStatusCounts()]);
  const totalCount = Object.values(statusCounts).reduce((sum, n) => sum + n, 0);
  return <section className="shell py-16">
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Admin</p>
          <h1 className="mt-4 font-display text-4xl font-semibold">AI Visibility leads</h1>
          <p className="mt-2 text-sm text-white/50">{leads.length} lead{leads.length === 1 ? "" : "s"} captured (latest 500)</p>
        </div>
        <div className="flex gap-3">
          <a href="/api/admin/leads/export" className="btn-secondary">Export CSV</a>
          <form action={logoutAction}><button type="submit" className="btn-secondary">Sign out</button></form>
        </div>
      </div>
      <div className="mt-8 flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-white/40">Filter:</span>
        {FILTERS.map((f) => {
          const isActive = (activeStatus ?? "") === f.value;
          return <a key={f.value} href={f.value ? `/admin/leads?status=${f.value}` : "/admin/leads"} className={`rounded-full border px-3 py-1 text-xs font-medium transition ${isActive ? "border-forge-lime/50 bg-forge-lime/10 text-forge-lime" : "border-white/10 text-white/50 hover:border-white/30 hover:text-white"}`} aria-current={isActive ? "page" : undefined}>{f.label} ({f.value ? statusCounts[f.value] ?? 0 : totalCount})</a>;
        })}
      </div>
      <div className="mt-4 overflow-x-auto rounded-xl border border-white/10">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-white/10 bg-white/[.03] text-xs uppercase tracking-wider text-white/50">
            <tr>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Website</th>
              <th className="px-4 py-3">Score</th>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Report</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {leads.length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-white/40">No leads yet. They&rsquo;ll appear here after someone runs an AI Visibility scan.</td></tr>}
            {leads.map((lead) => <tr key={lead.id} className="border-b border-white/5 last:border-0">
              <td className="px-4 py-3"><a href={`mailto:${lead.email}`} className="text-forge-lime hover:underline">{lead.email}</a></td>
              <td className="max-w-[16rem] truncate px-4 py-3"><a href={lead.url} target="_blank" rel="noopener noreferrer" className="hover:underline">{lead.url}</a></td>
              <td className="px-4 py-3 font-semibold">{lead.score}</td>
              <td className="whitespace-nowrap px-4 py-3 text-white/60">{new Date(lead.created_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</td>
              <td className="px-4 py-3"><a href={`/ai-visibility/r/${lead.id}`} target="_blank" className="text-white/60 hover:underline">View</a></td>
              <td className="whitespace-nowrap px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[lead.status]}`}>{STATUS_LABELS[lead.status]}</span>
                  {(["new", "contacted", "dismissed"] as const).filter((s) => s !== lead.status).map((s) => <form key={s} action={setStatusAction}>
                    <input type="hidden" name="id" value={lead.id} />
                    <input type="hidden" name="status" value={s} />
                    <button type="submit" className="rounded-full border border-white/10 px-2.5 py-0.5 text-xs text-white/50 transition hover:border-white/30 hover:text-white">{STATUS_LABELS[s]}</button>
                  </form>)}
                </div>
              </td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </div>
  </section>;
}
