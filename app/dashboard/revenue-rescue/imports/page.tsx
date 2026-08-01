import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { IMPORT_WRITE_ROLES, type OrgRole } from "@/lib/roles";
import { getEntitlement } from "@/lib/tenant";
import { listLeadImports } from "@/lib/rescue-import/store";
import { RescueImportsPanel } from "@/components/rescue-imports-panel";

export const metadata: Metadata = { title: "Lead imports — Revenue Rescue", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * Tenant-scoped import history + upload flow. The org is resolved from the
 * signed-in user's memberships — the ?org= param is only honored when the user
 * actually belongs to that organization.
 */
export default async function ImportsDashboardPage({ searchParams }: { searchParams: Promise<{ org?: string; highlight?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { org: orgParam, highlight } = await searchParams;

  const { rows: memberships } = await getPool().query(
    `SELECT o.id, o.name, m.role FROM memberships m JOIN organizations o ON o.id = m.organization_id
     WHERE m.user_id = $1 AND o.status = 'active' ORDER BY m.created_at ASC`,
    [user.id],
  );

  if (memberships.length === 0) {
    return (
      <section className="shell py-20">
        <div className="mx-auto max-w-2xl text-center">
          <p className="eyebrow">Revenue Rescue</p>
          <h1 className="mt-5 font-display text-5xl font-semibold">No workspace yet</h1>
          <p className="mt-4 text-sm leading-7 text-white/55">You&rsquo;re not part of an organization. Run the intake wizard to set up your Revenue Rescue workspace, or ask your team for an invite.</p>
          <Link href="/revenue-rescue/start" className="btn-primary mt-8 inline-flex">Start the intake wizard</Link>
        </div>
      </section>
    );
  }

  const active = memberships.find((m) => m.id === orgParam) ?? memberships[0];
  const role = active.role as OrgRole;
  const canWrite = IMPORT_WRITE_ROLES.includes(role);

  // The lead-import module is entitlement-gated — same boundary as the APIs.
  const entitlement = await getEntitlement(active.id, "lead_import");
  if (!entitlement?.enabled) {
    return (
      <section className="shell py-20">
        <div className="mx-auto max-w-2xl text-center">
          <p className="eyebrow">Revenue Rescue · {active.name}</p>
          <h1 className="mt-5 font-display text-5xl font-semibold">Lead imports aren&rsquo;t enabled</h1>
          <p className="mt-4 text-sm leading-7 text-white/55">The lead-import module isn&rsquo;t part of this organization&rsquo;s plan yet. Contact us to enable it.</p>
          <Link href="/contact" className="btn-primary mt-8 inline-flex">Talk to us</Link>
        </div>
      </section>
    );
  }

  const imports = await listLeadImports(active.id);

  return (
    <section className="shell py-14">
      <div className="mx-auto max-w-5xl">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow">Revenue Rescue · {active.name}</p>
            <h1 className="mt-4 font-display text-5xl font-semibold">Lead imports</h1>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-white/55">
              Every file moves through cleaning, deduplication, and suppression checks before leads land in your database. Files are stored privately and never publicly accessible.
            </p>
          </div>
          {memberships.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {memberships.map((m) => (
                <Link key={m.id} href={`/dashboard/revenue-rescue/imports?org=${m.id}`} className={`rounded-full border px-4 py-2 text-xs font-bold ${m.id === active.id ? "border-forge-lime text-forge-lime" : "border-white/15 text-white/50 hover:border-white/40"}`}>
                  {m.name}
                </Link>
              ))}
            </div>
          )}
        </div>
        <div className="mt-10">
          <RescueImportsPanel orgId={active.id} initialImports={imports} canWrite={canWrite} highlightId={highlight ?? null} />
        </div>
      </div>
    </section>
  );
}
