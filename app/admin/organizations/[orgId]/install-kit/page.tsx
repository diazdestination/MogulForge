import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { isPlatformAdmin } from "@/lib/admin-auth";
import { getOrganizationById, isInviteActive, listEntitlements, listInvites } from "@/lib/tenant";
import { FEATURE_LABELS } from "@/lib/entitlements";
import { PLAN_LABELS } from "@/lib/plans";

export const metadata: Metadata = { title: "Installation kit — Admin", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function InstallKitPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  if (!(await isPlatformAdmin())) redirect(`/admin/login?next=/admin/organizations/${orgId}/install-kit`);
  const org = await getOrganizationById(orgId).catch(() => null);
  if (!org) notFound();
  const [entitlements, invites] = await Promise.all([listEntitlements(orgId), listInvites(orgId)]);
  const enabled = entitlements.filter((e) => e.enabled);
  const ownerInvite = invites.find((invite) => invite.role === "owner" && isInviteActive(invite));
  const acceptedOwner = invites.find((invite) => invite.role === "owner" && invite.acceptedAt);

  const headerList = await headers();
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host") ?? "mogulforge.com";
  const proto = headerList.get("x-forwarded-proto") ?? "https";
  const base = `${proto}://${host}`;

  return <section className="shell py-16">
    <div className="mx-auto max-w-3xl">
      <p className="eyebrow"><Link href="/admin/organizations" className="hover:underline">MogulForge Admin</Link> / <Link href={`/admin/organizations/${org.id}`} className="hover:underline">{org.name}</Link></p>
      <h1 className="mt-4 font-display text-4xl font-semibold">Installation kit</h1>
      <p className="mt-2 text-sm text-white/50">Everything needed to onboard {org.name}. Share the owner invite link with the client.</p>

      <div className="mt-10 space-y-6">
        <div className="rounded-xl border border-forge-lime/30 bg-forge-lime/[.06] p-6">
          <h2 className="font-display text-2xl font-semibold">1. Owner invite</h2>
          {ownerInvite && <>
            <p className="mt-2 text-sm text-white/70">Send this link to <strong className="text-white">{ownerInvite.email}</strong>. It expires {new Date(ownerInvite.expiresAt).toLocaleDateString("en-US", { dateStyle: "medium" })}.</p>
            <p className="mt-3 break-all rounded-lg border border-white/10 bg-black/30 px-4 py-3 font-mono text-sm text-forge-lime">{base}/invite/{ownerInvite.token}</p>
          </>}
          {!ownerInvite && acceptedOwner && <p className="mt-2 text-sm text-white/70">✓ The owner ({acceptedOwner.email}) has already accepted their invite.</p>}
          {!ownerInvite && !acceptedOwner && <p className="mt-2 text-sm text-yellow-300">No active owner invite. Create one from the organization page if needed.</p>}
        </div>

        <div className="rounded-xl border border-white/10 bg-white/[.02] p-6">
          <h2 className="font-display text-2xl font-semibold">2. Account summary</h2>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-white/50">Organization</dt><dd className="font-semibold">{org.name} ({org.slug})</dd></div>
            <div><dt className="text-white/50">Plan</dt><dd className="font-semibold">{PLAN_LABELS[org.plan]}</dd></div>
            <div><dt className="text-white/50">Industry</dt><dd className="font-semibold">{org.industry ?? "—"}</dd></div>
            <div><dt className="text-white/50">Timezone</dt><dd className="font-semibold">{org.timezone}</dd></div>
            <div><dt className="text-white/50">Brand colors</dt><dd className="font-semibold">{org.brandPrimaryColor ?? "—"} / {org.brandSecondaryColor ?? "—"}</dd></div>
            <div><dt className="text-white/50">Status</dt><dd className="font-semibold">{org.status}</dd></div>
          </dl>
        </div>

        <div className="rounded-xl border border-white/10 bg-white/[.02] p-6">
          <h2 className="font-display text-2xl font-semibold">3. Enabled modules</h2>
          <ul className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
            {enabled.map((e) => <li key={e.featureKey} className="rounded-lg border border-white/10 px-4 py-2.5">✓ {FEATURE_LABELS[e.featureKey]}</li>)}
            {enabled.length === 0 && <li className="text-white/40">No modules enabled.</li>}
          </ul>
          <h3 className="mt-6 text-xs font-bold uppercase tracking-wider text-white/50">Usage limits</h3>
          <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
            {Object.entries(org.usageLimits).map(([key, value]) => <div key={key} className="flex justify-between rounded-lg border border-white/10 px-4 py-2"><dt className="text-white/50">{key.replaceAll("_", " ")}</dt><dd className="font-semibold">{String(value)}</dd></div>)}
            {Object.keys(org.usageLimits).length === 0 && <p className="text-white/40">No limits set.</p>}
          </dl>
        </div>

        <div className="rounded-xl border border-white/10 bg-white/[.02] p-6">
          <h2 className="font-display text-2xl font-semibold">4. Allowed origins</h2>
          <p className="mt-2 text-sm text-white/50">Domains cleared for future embeds and API access.</p>
          <ul className="mt-3 space-y-1.5 font-mono text-sm">
            {org.allowedOrigins.map((origin) => <li key={origin} className="rounded-lg border border-white/10 px-4 py-2">{origin}</li>)}
            {org.allowedOrigins.length === 0 && <li className="font-sans text-white/40">None configured yet.</li>}
          </ul>
        </div>
      </div>
    </div>
  </section>;
}
