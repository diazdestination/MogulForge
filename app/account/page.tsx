import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { destroyUserSession, getCurrentUser } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { ROLE_LABELS, type OrgRole } from "@/lib/roles";
import { PLAN_LABELS, type Plan } from "@/lib/plans";

export const metadata: Metadata = { title: "Your account", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

async function logoutAction() {
  "use server";
  await destroyUserSession();
  redirect("/login");
}

export default async function AccountPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { rows } = await getPool().query(
    `SELECT o.id, o.name, o.plan, o.status, m.role FROM memberships m JOIN organizations o ON o.id = m.organization_id
     WHERE m.user_id = $1 ORDER BY m.created_at ASC`,
    [user.id],
  );
  return <section className="shell py-16">
    <div className="mx-auto max-w-3xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Client portal</p>
          <h1 className="mt-4 font-display text-4xl font-semibold">Welcome, {user.name}</h1>
          <p className="mt-2 text-sm text-white/50">{user.email}{user.platformRole ? ` — MogulForge ${user.platformRole === "platform_admin" ? "Platform Admin" : "Support Admin"}` : ""}</p>
        </div>
        <form action={logoutAction}><button type="submit" className="btn-secondary">Sign out</button></form>
      </div>
      {user.platformRole && <p className="mt-6 text-sm"><Link href="/admin/organizations" className="text-forge-lime hover:underline">Open the MogulForge admin portal →</Link></p>}
      <h2 className="mt-10 font-display text-2xl font-semibold">Your organizations</h2>
      {rows.length === 0 && <p className="mt-4 text-sm text-white/50">You&rsquo;re not part of an organization yet. If your company uses Revenue Rescue, ask an admin to send you an invite link.</p>}
      <div className="mt-4 space-y-3">
        {rows.map((org) => <div key={org.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[.03] px-5 py-4">
          <div>
            <p className="font-semibold">{org.name}</p>
            <p className="text-xs text-white/50">{PLAN_LABELS[org.plan as Plan] ?? org.plan} plan · {org.status}</p>
          </div>
          <span className="rounded-full border border-forge-lime/40 px-3 py-1 text-xs font-bold text-forge-lime">{ROLE_LABELS[org.role as OrgRole] ?? org.role}</span>
        </div>)}
      </div>
    </div>
  </section>;
}
