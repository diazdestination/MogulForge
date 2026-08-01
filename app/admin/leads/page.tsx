import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { checkPassword, createAdminSession, destroyAdminSession, isAdmin } from "@/lib/admin-auth";

export const metadata: Metadata = { title: "Leads — Admin", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

type Lead = { id: string; url: string; email: string; score: number; created_at: string };

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

async function getLeads(): Promise<Lead[]> {
  const { rows } = await getPool().query(
    "SELECT id, url, email, score, created_at FROM visibility_reports ORDER BY created_at DESC LIMIT 500",
  );
  return rows;
}

export default async function AdminLeadsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
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

  const leads = await getLeads();
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
      <div className="mt-8 overflow-x-auto rounded-xl border border-white/10">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-white/10 bg-white/[.03] text-xs uppercase tracking-wider text-white/50">
            <tr>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Website</th>
              <th className="px-4 py-3">Score</th>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Report</th>
            </tr>
          </thead>
          <tbody>
            {leads.length === 0 && <tr><td colSpan={5} className="px-4 py-10 text-center text-white/40">No leads yet. They&rsquo;ll appear here after someone runs an AI Visibility scan.</td></tr>}
            {leads.map((lead) => <tr key={lead.id} className="border-b border-white/5 last:border-0">
              <td className="px-4 py-3"><a href={`mailto:${lead.email}`} className="text-forge-lime hover:underline">{lead.email}</a></td>
              <td className="max-w-[16rem] truncate px-4 py-3"><a href={lead.url} target="_blank" rel="noopener noreferrer" className="hover:underline">{lead.url}</a></td>
              <td className="px-4 py-3 font-semibold">{lead.score}</td>
              <td className="whitespace-nowrap px-4 py-3 text-white/60">{new Date(lead.created_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</td>
              <td className="px-4 py-3"><a href={`/ai-visibility/r/${lead.id}`} target="_blank" className="text-white/60 hover:underline">View</a></td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </div>
  </section>;
}
