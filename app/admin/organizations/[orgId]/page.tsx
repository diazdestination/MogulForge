import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isPlatformAdmin } from "@/lib/admin-auth";
import { getCurrentUser } from "@/lib/auth";
import { getOrganizationById, isInviteActive, listEntitlements, listInvites, listMembers, setEntitlement, updateOrganization } from "@/lib/tenant";
import { FEATURE_KEYS, FEATURE_LABELS, isFeatureKey } from "@/lib/entitlements";
import { PLANS, PLAN_LABELS, ORG_STATUSES, isPlan } from "@/lib/plans";
import { ROLE_LABELS } from "@/lib/roles";
import { logAudit } from "@/lib/audit";

export const metadata: Metadata = { title: "Organization — Admin", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

async function actorLabel() {
  const user = await getCurrentUser();
  return user?.platformRole
    ? { userId: user.id, label: `${user.email} (${user.platformRole})` }
    : { userId: null, label: "platform-admin (password)" };
}

async function updateOrgAction(formData: FormData) {
  "use server";
  const orgId = String(formData.get("orgId") ?? "");
  if (!(await isPlatformAdmin())) redirect(`/admin/login?next=/admin/organizations/${orgId}`);
  const plan = String(formData.get("plan") ?? "");
  const status = String(formData.get("status") ?? "");
  const patch: Record<string, unknown> = {};
  if (isPlan(plan)) patch.plan = plan;
  if ((ORG_STATUSES as readonly string[]).includes(status)) patch.status = status;
  patch.industry = String(formData.get("industry") ?? "").trim() || null;
  patch.timezone = String(formData.get("timezone") ?? "").trim() || "America/New_York";
  patch.brandPrimaryColor = String(formData.get("brandPrimaryColor") ?? "").trim() || null;
  patch.brandSecondaryColor = String(formData.get("brandSecondaryColor") ?? "").trim() || null;
  patch.allowedOrigins = String(formData.get("allowedOrigins") ?? "").split(/[\n,]/).map((o) => o.trim()).filter(Boolean);
  await updateOrganization(orgId, patch);
  const actor = await actorLabel();
  await logAudit({ organizationId: orgId, actorUserId: actor.userId, actorLabel: actor.label, action: "org.updated", targetType: "organization", targetId: orgId, metadata: { fields: Object.keys(patch) } });
  redirect(`/admin/organizations/${orgId}`);
}

async function toggleModuleAction(formData: FormData) {
  "use server";
  const orgId = String(formData.get("orgId") ?? "");
  if (!(await isPlatformAdmin())) redirect(`/admin/login?next=/admin/organizations/${orgId}`);
  const featureKey = String(formData.get("featureKey") ?? "");
  const enable = String(formData.get("enable") ?? "") === "1";
  if (isFeatureKey(featureKey)) {
    await setEntitlement(orgId, featureKey, enable);
    const actor = await actorLabel();
    await logAudit({ organizationId: orgId, actorUserId: actor.userId, actorLabel: actor.label, action: "org.module_toggled", targetType: "entitlement", targetId: featureKey, metadata: { enabled: enable } });
  }
  redirect(`/admin/organizations/${orgId}`);
}

export default async function AdminOrganizationDetailPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  if (!(await isPlatformAdmin())) redirect(`/admin/login?next=/admin/organizations/${orgId}`);
  const org = await getOrganizationById(orgId).catch(() => null);
  if (!org) notFound();
  const [members, entitlements, invites] = await Promise.all([listMembers(orgId), listEntitlements(orgId), listInvites(orgId)]);
  const enabledByKey = new Map(entitlements.map((e) => [e.featureKey, e.enabled]));
  const pendingInvites = invites.filter((invite) => isInviteActive(invite));
  const inputClass = "w-full rounded-xl border border-white/10 bg-white/[.04] px-4 py-2.5 text-sm outline-none focus:border-forge-lime/50";
  const labelClass = "block text-xs font-bold uppercase tracking-wider text-white/50";

  return <section className="shell py-16">
    <div className="mx-auto max-w-5xl">
      <p className="eyebrow"><Link href="/admin/organizations" className="hover:underline">MogulForge Admin</Link> / Organizations</p>
      <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl font-semibold">{org.name}</h1>
          <p className="mt-2 text-sm text-white/50">{org.slug} · {PLAN_LABELS[org.plan]} · {org.status}{org.industry ? ` · ${org.industry}` : ""}</p>
        </div>
        <Link href={`/admin/organizations/${org.id}/install-kit`} className="btn-secondary">Installation kit</Link>
      </div>

      <div className="mt-10 grid gap-10 lg:grid-cols-2">
        <div>
          <h2 className="font-display text-2xl font-semibold">Settings</h2>
          <form action={updateOrgAction} className="mt-4 space-y-4 rounded-xl border border-white/10 bg-white/[.02] p-5">
            <input type="hidden" name="orgId" value={org.id} />
            <div className="grid gap-4 sm:grid-cols-2">
              <div><label className={labelClass}>Plan</label>
                <select name="plan" defaultValue={org.plan} className={`mt-2 ${inputClass}`}>{PLANS.map((plan) => <option key={plan} value={plan}>{PLAN_LABELS[plan]}</option>)}</select>
              </div>
              <div><label className={labelClass}>Status</label>
                <select name="status" defaultValue={org.status} className={`mt-2 ${inputClass}`}>{ORG_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}</select>
              </div>
              <div><label className={labelClass}>Industry</label><input name="industry" defaultValue={org.industry ?? ""} className={`mt-2 ${inputClass}`} /></div>
              <div><label className={labelClass}>Timezone</label><input name="timezone" defaultValue={org.timezone} className={`mt-2 ${inputClass}`} /></div>
              <div><label className={labelClass}>Primary color</label><input name="brandPrimaryColor" defaultValue={org.brandPrimaryColor ?? ""} className={`mt-2 ${inputClass}`} /></div>
              <div><label className={labelClass}>Secondary color</label><input name="brandSecondaryColor" defaultValue={org.brandSecondaryColor ?? ""} className={`mt-2 ${inputClass}`} /></div>
            </div>
            <div><label className={labelClass}>Allowed origins</label><textarea name="allowedOrigins" rows={2} defaultValue={org.allowedOrigins.join("\n")} className={`mt-2 ${inputClass}`} /></div>
            <button type="submit" className="btn-secondary">Save settings</button>
          </form>

          <h2 className="mt-10 font-display text-2xl font-semibold">Usage limits</h2>
          <div className="mt-4 rounded-xl border border-white/10 bg-white/[.02] p-5 text-sm">
            {Object.keys(org.usageLimits).length === 0 && <p className="text-white/40">No limits set.</p>}
            <dl className="grid grid-cols-2 gap-2">
              {Object.entries(org.usageLimits).map(([key, value]) => <div key={key} className="flex justify-between gap-2 border-b border-white/5 py-1 last:border-0">
                <dt className="text-white/50">{key.replaceAll("_", " ")}</dt><dd className="font-semibold">{String(value)}</dd>
              </div>)}
            </dl>
          </div>
        </div>

        <div>
          <h2 className="font-display text-2xl font-semibold">Modules</h2>
          <div className="mt-4 space-y-2">
            {FEATURE_KEYS.map((key) => {
              const enabled = enabledByKey.get(key) ?? false;
              return <div key={key} className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[.02] px-4 py-3 text-sm">
                <span>{FEATURE_LABELS[key]}</span>
                <form action={toggleModuleAction}>
                  <input type="hidden" name="orgId" value={org.id} />
                  <input type="hidden" name="featureKey" value={key} />
                  <input type="hidden" name="enable" value={enabled ? "0" : "1"} />
                  <button type="submit" className={`rounded-full border px-3 py-1 text-xs font-bold ${enabled ? "border-forge-lime/50 text-forge-lime" : "border-white/20 text-white/40"}`}>
                    {enabled ? "Enabled — turn off" : "Disabled — turn on"}
                  </button>
                </form>
              </div>;
            })}
          </div>

          <h2 className="mt-10 font-display text-2xl font-semibold">Members</h2>
          <div className="mt-4 overflow-x-auto rounded-xl border border-white/10">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-white/10 bg-white/[.03] text-xs uppercase tracking-wider text-white/50"><tr><th className="px-4 py-2.5">Name</th><th className="px-4 py-2.5">Email</th><th className="px-4 py-2.5">Role</th></tr></thead>
              <tbody>
                {members.length === 0 && <tr><td colSpan={3} className="px-4 py-6 text-center text-white/40">No members yet — the owner hasn&rsquo;t accepted the invite.</td></tr>}
                {members.map((member) => <tr key={member.membershipId} className="border-b border-white/5 last:border-0">
                  <td className="px-4 py-2.5">{member.name}</td>
                  <td className="px-4 py-2.5 text-white/60">{member.email}</td>
                  <td className="px-4 py-2.5">{ROLE_LABELS[member.role]}</td>
                </tr>)}
              </tbody>
            </table>
          </div>

          <h2 className="mt-10 font-display text-2xl font-semibold">Pending invites</h2>
          <div className="mt-4 space-y-2 text-sm">
            {pendingInvites.length === 0 && <p className="text-white/40">No pending invites.</p>}
            {pendingInvites.map((invite) => <div key={invite.id} className="rounded-xl border border-white/10 bg-white/[.02] px-4 py-3">
              <p className="font-semibold">{invite.email} <span className="ml-2 text-xs font-normal text-white/50">{ROLE_LABELS[invite.role]}</span></p>
              <p className="mt-1 break-all text-xs text-white/50">Invite link: /invite/{invite.token}</p>
            </div>)}
          </div>
        </div>
      </div>
    </div>
  </section>;
}
