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
import { getOrgSubscription, listPlanDefinitions, setOrgSubscription } from "@/lib/subscriptions";
import { getBillingAdapter } from "@/lib/billing";
import { getUsageStatus } from "@/lib/usage";
import { SUBSCRIPTION_STATUSES, isSubscriptionStatus, isUsageMetric, USAGE_METRIC_LABELS, type LimitSet } from "@/lib/usage-metrics";
import { activateCustomDomain, checkCustomDomain, listCustomDomains, setDomainSslStatus, verifyCustomDomain } from "@/lib/custom-domains";
import { DOMAIN_STATUS_LABELS } from "@/lib/custom-domain-core";
import { DomainGoLiveChecklist } from "@/components/domain-go-live-checklist";

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

const OVERRIDE_KEYS = ["seats", "leads_stored", "leads_imported", "ai_jobs", "messages_generated", "sms_sent", "emails_sent", "api_requests"] as const;

async function saveSubscriptionAction(formData: FormData) {
  "use server";
  const orgId = String(formData.get("orgId") ?? "");
  if (!(await isPlatformAdmin())) redirect(`/admin/login?next=/admin/organizations/${orgId}`);
  const planId = String(formData.get("subscriptionPlanId") ?? "");
  const status = String(formData.get("subscriptionStatus") ?? "active");
  const trialRaw = String(formData.get("trialEndsAt") ?? "").trim();
  const previous = await getOrgSubscription(orgId);
  const subscription = await setOrgSubscription(orgId, {
    planId,
    status: isSubscriptionStatus(status) ? status : "active",
    trialEndsAt: trialRaw && !Number.isNaN(Date.parse(trialRaw)) ? new Date(trialRaw).toISOString() : null,
    notes: String(formData.get("subscriptionNotes") ?? "").trim() || null,
  });
  // Billing adapter (provider-neutral): record the change with whatever provider handles this org.
  const adapter = getBillingAdapter(subscription.billingProvider);
  if (previous && previous.planId !== planId) {
    await adapter.changePlan({ organizationId: orgId, billingRef: subscription.billingRef, fromPlanId: previous.planId, toPlanId: planId });
  } else if (!previous) {
    await adapter.createSubscription({ organizationId: orgId, planId });
  }
  const actor = await actorLabel();
  await logAudit({ organizationId: orgId, actorUserId: actor.userId, actorLabel: actor.label, action: "subscription.updated", targetType: "org_subscription", targetId: orgId, metadata: { planId, status, previousPlanId: previous?.planId ?? null } });
  redirect(`/admin/organizations/${orgId}`);
}

async function saveLimitOverridesAction(formData: FormData) {
  "use server";
  const orgId = String(formData.get("orgId") ?? "");
  if (!(await isPlatformAdmin())) redirect(`/admin/login?next=/admin/organizations/${orgId}`);
  const overrides: LimitSet = {};
  for (const key of OVERRIDE_KEYS) {
    const raw = String(formData.get(`override_${key}`) ?? "").trim();
    if (raw === "") continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) overrides[key] = Math.floor(value);
  }
  await updateOrganization(orgId, { usageLimits: overrides });
  const actor = await actorLabel();
  await logAudit({ organizationId: orgId, actorUserId: actor.userId, actorLabel: actor.label, action: "usage_limits.overridden", targetType: "organization", targetId: orgId, metadata: { overrides } });
  redirect(`/admin/organizations/${orgId}`);
}

async function domainAdminAction(formData: FormData) {
  "use server";
  const orgId = String(formData.get("orgId") ?? "");
  if (!(await isPlatformAdmin())) redirect(`/admin/login?next=/admin/organizations/${orgId}`);
  const domainId = String(formData.get("domainId") ?? "");
  const action = String(formData.get("domainAction") ?? "");
  const actor = await actorLabel();
  if (action === "verify") {
    const result = await checkCustomDomain(orgId, domainId);
    if (result?.newlyVerified) await logAudit({ organizationId: orgId, actorUserId: actor.userId, actorLabel: actor.label, action: "custom_domain.verified", targetType: "custom_domain", targetId: domainId });
  } else if (action === "force_verify") {
    const result = await verifyCustomDomain(orgId, domainId, { force: true });
    if (result?.verified) await logAudit({ organizationId: orgId, actorUserId: actor.userId, actorLabel: actor.label, action: "custom_domain.force_verified", targetType: "custom_domain", targetId: domainId });
  } else if (action === "activate") {
    const result = await activateCustomDomain(orgId, domainId);
    if (result.ok) await logAudit({ organizationId: orgId, actorUserId: actor.userId, actorLabel: actor.label, action: "custom_domain.activated", targetType: "custom_domain", targetId: domainId });
  } else if (action === "ssl_issued") {
    await setDomainSslStatus(orgId, domainId, "issued");
    await logAudit({ organizationId: orgId, actorUserId: actor.userId, actorLabel: actor.label, action: "custom_domain.ssl_issued", targetType: "custom_domain", targetId: domainId });
  }
  redirect(`/admin/organizations/${orgId}`);
}

export default async function AdminOrganizationDetailPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  if (!(await isPlatformAdmin())) redirect(`/admin/login?next=/admin/organizations/${orgId}`);
  const org = await getOrganizationById(orgId).catch(() => null);
  if (!org) notFound();
  const [members, entitlements, invites, subscription, planDefs, usage, domains] = await Promise.all([
    listMembers(orgId),
    listEntitlements(orgId),
    listInvites(orgId),
    getOrgSubscription(orgId),
    listPlanDefinitions(),
    getUsageStatus(orgId),
    listCustomDomains(orgId),
  ]);
  const adapter = getBillingAdapter(subscription?.billingProvider);
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

          <h2 className="mt-10 font-display text-2xl font-semibold">Subscription</h2>
          <form action={saveSubscriptionAction} className="mt-4 space-y-4 rounded-xl border border-white/10 bg-white/[.02] p-5">
            <input type="hidden" name="orgId" value={org.id} />
            <div className="grid gap-4 sm:grid-cols-2">
              <div><label className={labelClass}>Plan</label>
                <select name="subscriptionPlanId" defaultValue={subscription?.planId ?? org.plan} className={`mt-2 ${inputClass}`}>
                  {planDefs.map((plan) => <option key={plan.id} value={plan.id}>{plan.name} (${plan.price}/{plan.cadence === "one-time" ? "once" : "mo"})</option>)}
                </select>
              </div>
              <div><label className={labelClass}>Account state</label>
                <select name="subscriptionStatus" defaultValue={subscription?.status ?? "active"} className={`mt-2 ${inputClass}`}>
                  {SUBSCRIPTION_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
                </select>
              </div>
              <div><label className={labelClass}>Trial ends (for trialing)</label>
                <input name="trialEndsAt" type="date" defaultValue={subscription?.trialEndsAt ? subscription.trialEndsAt.slice(0, 10) : ""} className={`mt-2 ${inputClass}`} />
              </div>
              <div><label className={labelClass}>Notes</label><input name="subscriptionNotes" defaultValue={subscription?.notes ?? ""} className={`mt-2 ${inputClass}`} /></div>
            </div>
            <p className="text-xs text-white/40">Billing adapter: <span className="font-bold text-white/60">{adapter.provider}</span> — {adapter.description}</p>
            <button type="submit" className="btn-secondary">Save subscription</button>
          </form>

          <h2 className="mt-10 font-display text-2xl font-semibold">Usage & limit overrides</h2>
          <div className="mt-4 rounded-xl border border-white/10 bg-white/[.02] p-5 text-sm">
            {usage && <>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-full border border-forge-lime/40 px-3 py-1 font-bold text-forge-lime">{usage.plan.name}</span>
                <span className="text-white/50">period {usage.period}</span>
                {usage.limitExempt && <span className="text-white/40">internal — limits exempt</span>}
                {usage.warnings.map((warning) => <span key={warning.metric} className={`rounded-full border px-2 py-0.5 font-bold ${warning.warning === 100 ? "border-red-400/50 text-red-400" : "border-amber-400/50 text-amber-300"}`}>{warning.label.replace(" (incl. simulated)", "")} {warning.warning}%</span>)}
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-2">
                {usage.lines.map((line) => <div key={line.metric} className="flex justify-between gap-2 border-b border-white/5 py-1 last:border-0">
                  <dt className="text-white/50">{line.label.replace(" (incl. simulated)", "")}</dt>
                  <dd className="font-semibold tabular-nums">{line.used.toLocaleString()}{line.limit !== null && <span className="text-white/40"> / {line.limit.toLocaleString()}</span>}</dd>
                </div>)}
              </dl>
            </>}
            <form action={saveLimitOverridesAction} className="mt-5 border-t border-white/10 pt-4">
              <input type="hidden" name="orgId" value={org.id} />
              <p className={labelClass}>Per-org limit overrides (blank = use plan limit)</p>
              <div className="mt-2 grid grid-cols-2 gap-3">
                {OVERRIDE_KEYS.map((key) => <div key={key}>
                  <label className="block text-xs text-white/50">{key === "seats" ? "Seats" : isUsageMetric(key) ? USAGE_METRIC_LABELS[key].replace(" (incl. simulated)", "") : key}</label>
                  <input name={`override_${key}`} type="number" min={0} defaultValue={(org.usageLimits as Record<string, number>)[key] ?? ""} className={`mt-1 ${inputClass}`} />
                </div>)}
              </div>
              <button type="submit" className="btn-secondary mt-4">Save overrides</button>
            </form>
          </div>

          <h2 className="mt-10 font-display text-2xl font-semibold">Custom domains</h2>
          <div className="mt-4 space-y-3">
            {domains.length === 0 && <p className="text-sm text-white/40">None requested.</p>}
            {domains.map((domain) => <div key={domain.id} className="rounded-xl border border-white/10 bg-white/[.02] p-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-semibold">{domain.domain}</p>
                  <p className="mt-0.5 text-xs text-white/50">{DOMAIN_STATUS_LABELS[domain.status]} · SSL: {domain.sslStatus.replace("_", " ")}{domain.lastCheckedAt && ` · last checked ${new Date(domain.lastCheckedAt).toLocaleString()}`}</p>
                  {domain.lastCheckError && <p className="mt-1 text-xs text-amber-300">{domain.lastCheckError}</p>}
                  <DomainGoLiveChecklist domain={domain} />
                </div>
                <div className="flex flex-wrap gap-2">
                  <form action={domainAdminAction}><input type="hidden" name="orgId" value={org.id} /><input type="hidden" name="domainId" value={domain.id} /><input type="hidden" name="domainAction" value="verify" /><button type="submit" className="btn-secondary">{domain.status === "pending_dns" ? "Check DNS" : "Check now"}</button></form>
                  {domain.status === "pending_dns" && <form action={domainAdminAction}><input type="hidden" name="orgId" value={org.id} /><input type="hidden" name="domainId" value={domain.id} /><input type="hidden" name="domainAction" value="force_verify" /><button type="submit" className="rounded-full border border-amber-400/40 px-4 py-2 text-xs font-bold text-amber-300 hover:bg-amber-400/10">Force verify</button></form>}
                  {domain.status === "verified" && <form action={domainAdminAction}><input type="hidden" name="orgId" value={org.id} /><input type="hidden" name="domainId" value={domain.id} /><input type="hidden" name="domainAction" value="activate" /><button type="submit" className="rounded-full border border-forge-lime/50 px-4 py-2 text-xs font-bold text-forge-lime hover:bg-forge-lime/10">Activate</button></form>}
                  {domain.status === "active" && domain.sslStatus !== "issued" && <form action={domainAdminAction}><input type="hidden" name="orgId" value={org.id} /><input type="hidden" name="domainId" value={domain.id} /><input type="hidden" name="domainAction" value="ssl_issued" /><button type="submit" className="btn-secondary">Mark SSL issued</button></form>}
                </div>
              </div>
            </div>)}
            <p className="text-xs text-white/40">Activation only records intent — routing and SSL for custom domains are completed manually (platform-dependent). See replit.md → Custom domains runbook.</p>
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
