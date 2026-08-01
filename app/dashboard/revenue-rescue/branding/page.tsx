import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDashboardContext } from "@/lib/dashboard-context";
import { RescueDashboardGate } from "@/components/rescue-dashboard-gate";
import { getCurrentUser } from "@/lib/auth";
import { getMembership, getOrganizationById, getEntitlement } from "@/lib/tenant";
import { MANAGER_ROLES } from "@/lib/roles";
import { BRANDING_LEVELS, BRANDING_LEVEL_LABELS } from "@/lib/branding-core";
import { BrandingValidationError, resolveOrgBranding, updateOrgBranding } from "@/lib/branding";
import { DomainRequestError, listCustomDomains, requestCustomDomain, removeCustomDomain, verifyCustomDomain } from "@/lib/custom-domains";
import { DOMAIN_STATUS_LABELS } from "@/lib/custom-domain-core";
import { logAudit } from "@/lib/audit";

export const metadata: Metadata = { title: "Branding — Dashboard", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** Server-action guard: signed-in owner/admin of the org. */
async function requireManagerAction(orgId: string) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const membership = await getMembership(orgId, user.id);
  if (!membership || !MANAGER_ROLES.includes(membership.role)) redirect("/dashboard/revenue-rescue/branding");
  return user;
}

async function saveBrandingAction(formData: FormData) {
  "use server";
  const orgId = String(formData.get("orgId") ?? "");
  const user = await requireManagerAction(orgId);
  const read = (name: string) => String(formData.get(name) ?? "").trim() || null;
  try {
    await updateOrgBranding(orgId, {
      brandingLevel: String(formData.get("brandingLevel") ?? "mogulforge"),
      displayName: read("displayName"),
      logoUrl: read("logoUrl"),
      brandPrimaryColor: read("brandPrimaryColor"),
      brandSecondaryColor: read("brandSecondaryColor"),
      portalTitle: read("portalTitle"),
      loginTitle: read("loginTitle"),
      supportEmail: read("supportEmail"),
      supportPhone: read("supportPhone"),
      emailSenderName: read("emailSenderName"),
      smsSenderName: read("smsSenderName"),
      poweredByLabel: read("poweredByLabel"),
    });
  } catch (error) {
    if (error instanceof BrandingValidationError) redirect(`/dashboard/revenue-rescue/branding?org=${orgId}&error=${encodeURIComponent(error.message)}`);
    throw error;
  }
  await logAudit({ organizationId: orgId, actorUserId: user.id, actorLabel: user.email, action: "branding.updated", targetType: "organization", targetId: orgId });
  redirect(`/dashboard/revenue-rescue/branding?org=${orgId}&saved=1`);
}

async function requestDomainAction(formData: FormData) {
  "use server";
  const orgId = String(formData.get("orgId") ?? "");
  const user = await requireManagerAction(orgId);
  try {
    const domain = await requestCustomDomain(orgId, String(formData.get("domain") ?? ""));
    await logAudit({ organizationId: orgId, actorUserId: user.id, actorLabel: user.email, action: "custom_domain.requested", targetType: "custom_domain", targetId: domain.id, metadata: { domain: domain.domain } });
  } catch (error) {
    if (error instanceof DomainRequestError) redirect(`/dashboard/revenue-rescue/branding?org=${orgId}&error=${encodeURIComponent(error.message)}`);
    throw error;
  }
  redirect(`/dashboard/revenue-rescue/branding?org=${orgId}`);
}

async function verifyDomainAction(formData: FormData) {
  "use server";
  const orgId = String(formData.get("orgId") ?? "");
  const user = await requireManagerAction(orgId);
  const domainId = String(formData.get("domainId") ?? "");
  const result = await verifyCustomDomain(orgId, domainId);
  if (result?.verified) {
    await logAudit({ organizationId: orgId, actorUserId: user.id, actorLabel: user.email, action: "custom_domain.verified", targetType: "custom_domain", targetId: domainId });
  }
  redirect(`/dashboard/revenue-rescue/branding?org=${orgId}${result && !result.verified ? `&error=${encodeURIComponent(result.error ?? "Verification failed.")}` : ""}`);
}

async function removeDomainAction(formData: FormData) {
  "use server";
  const orgId = String(formData.get("orgId") ?? "");
  const user = await requireManagerAction(orgId);
  const domainId = String(formData.get("domainId") ?? "");
  await removeCustomDomain(orgId, domainId);
  await logAudit({ organizationId: orgId, actorUserId: user.id, actorLabel: user.email, action: "custom_domain.removed", targetType: "custom_domain", targetId: domainId });
  redirect(`/dashboard/revenue-rescue/branding?org=${orgId}`);
}

export default async function BrandingPage({ searchParams }: { searchParams: Promise<{ org?: string; saved?: string; error?: string }> }) {
  const { org: orgParam, saved, error } = await searchParams;
  const ctx = await getDashboardContext(orgParam, "revenue_rescue");
  if (ctx.kind === "unauthenticated") redirect("/login");
  if (ctx.kind !== "ok") return <RescueDashboardGate ctx={ctx} />;
  const canManage = MANAGER_ROLES.includes(ctx.role);

  const org = await getOrganizationById(ctx.active.id);
  if (!org) return null;
  const [branding, whiteLabel, domains] = await Promise.all([
    resolveOrgBranding(org),
    getEntitlement(org.id, "white_label"),
    listCustomDomains(org.id),
  ]);

  const inputClass = "w-full rounded-xl border border-white/10 bg-white/[.04] px-4 py-2.5 text-sm outline-none focus:border-forge-lime/50 disabled:opacity-40";
  const labelClass = "block text-xs font-bold uppercase tracking-wider text-white/50";

  return (
    <section className="shell py-10">
      <div className="mx-auto max-w-5xl">
        <p className="eyebrow">Revenue Rescue · {ctx.active.name}</p>
        <h1 className="mt-4 font-display text-5xl font-semibold">Branding</h1>
        <p className="mt-3 max-w-2xl text-sm text-white/50">
          How your portal, embeds, and outgoing messages present themselves. Changes apply immediately across the dashboard and embedded widgets.
        </p>

        {saved && <div className="mt-6 rounded-xl border border-forge-lime/40 bg-forge-lime/5 px-5 py-3 text-sm text-forge-lime">Branding saved.</div>}
        {error && <div className="mt-6 rounded-xl border border-red-400/40 bg-red-400/5 px-5 py-3 text-sm text-red-300">{error}</div>}
        {!canManage && <div className="mt-6 rounded-xl border border-white/15 bg-white/[.03] px-5 py-3 text-sm text-white/60">You can view these settings; only owners and admins can change them.</div>}

        <form action={saveBrandingAction} className="mt-8 rounded-xl border border-white/10 bg-white/[.02] p-6">
          <input type="hidden" name="orgId" value={org.id} />
          <fieldset disabled={!canManage} className="space-y-6">
            <div>
              <label className={labelClass}>Branding level</label>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                {BRANDING_LEVELS.map((level) => {
                  const gated = level === "white_label" && !whiteLabel?.enabled;
                  return (
                    <label key={level} className={`flex cursor-pointer flex-col gap-1 rounded-xl border p-4 text-sm ${org.brandingLevel === level ? "border-forge-lime/60 bg-forge-lime/5" : "border-white/10 bg-white/[.02]"}`}>
                      <span className="flex items-center gap-2 font-semibold">
                        <input type="radio" name="brandingLevel" value={level} defaultChecked={org.brandingLevel === level} />
                        {BRANDING_LEVEL_LABELS[level]}
                      </span>
                      <span className="text-xs text-white/50">
                        {level === "mogulforge" && "Standard MogulForge look — your company name, our brand."}
                        {level === "powered_by" && "Your logo, colors, and titles with a “Powered by MogulForge” line."}
                        {level === "white_label" && (gated
                          ? "Requires the Full White Label entitlement — settings save now and apply once MogulForge enables it (until then your portal shows Powered by MogulForge)."
                          : "Your brand only. The powered-by line is optional and fully yours.")}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div><label className={labelClass}>Display name</label><input name="displayName" defaultValue={org.displayName ?? ""} placeholder={org.name} className={`mt-2 ${inputClass}`} /></div>
              <div><label className={labelClass}>Logo URL (https)</label><input name="logoUrl" defaultValue={org.logoUrl ?? ""} placeholder="https://…/logo.png" className={`mt-2 ${inputClass}`} /></div>
              <div><label className={labelClass}>Primary color</label><input name="brandPrimaryColor" defaultValue={org.brandPrimaryColor ?? ""} placeholder="#C8F31D" className={`mt-2 ${inputClass}`} /></div>
              <div><label className={labelClass}>Secondary color</label><input name="brandSecondaryColor" defaultValue={org.brandSecondaryColor ?? ""} placeholder="#101418" className={`mt-2 ${inputClass}`} /></div>
              <div><label className={labelClass}>Portal title</label><input name="portalTitle" defaultValue={org.portalTitle ?? ""} placeholder={`${org.name} — Revenue Rescue`} className={`mt-2 ${inputClass}`} /></div>
              <div><label className={labelClass}>Login title</label><input name="loginTitle" defaultValue={org.loginTitle ?? ""} placeholder={`Sign in to ${org.name}`} className={`mt-2 ${inputClass}`} /></div>
              <div><label className={labelClass}>Support email</label><input name="supportEmail" defaultValue={org.supportEmail ?? ""} className={`mt-2 ${inputClass}`} /></div>
              <div><label className={labelClass}>Support phone</label><input name="supportPhone" defaultValue={org.supportPhone ?? ""} className={`mt-2 ${inputClass}`} /></div>
              <div><label className={labelClass}>Email sender name</label><input name="emailSenderName" defaultValue={org.emailSenderName ?? ""} placeholder={branding.displayName} className={`mt-2 ${inputClass}`} /></div>
              <div><label className={labelClass}>SMS sender name</label><input name="smsSenderName" defaultValue={org.smsSenderName ?? ""} placeholder={branding.displayName} className={`mt-2 ${inputClass}`} /></div>
              <div className="sm:col-span-2"><label className={labelClass}>Powered-by label (white label only — leave blank to hide)</label><input name="poweredByLabel" defaultValue={org.poweredByLabel ?? ""} className={`mt-2 ${inputClass}`} /></div>
            </div>
            {canManage && <button type="submit" className="btn-secondary">Save branding</button>}
          </fieldset>
        </form>

        <div className="mt-6 rounded-xl border border-white/10 bg-white/[.02] px-6 py-4 text-sm text-white/60">
          <span className="font-bold text-white/80">Currently live:</span> {BRANDING_LEVEL_LABELS[branding.level]}
          {branding.requestedLevel !== branding.level && <span className="ml-2 text-amber-300">(you selected {BRANDING_LEVEL_LABELS[branding.requestedLevel]}, pending entitlement)</span>}
          {branding.poweredBy.show && <span className="ml-2 text-white/40">· footer shows “{branding.poweredBy.label}”</span>}
        </div>

        <h2 className="mt-12 font-display text-3xl font-semibold">Custom domain</h2>
        <p className="mt-2 max-w-2xl text-sm text-white/50">
          Serve your portal from your own domain. Add the DNS records below, verify, and MogulForge completes routing and SSL manually after activation.
        </p>

        {canManage && (
          <form action={requestDomainAction} className="mt-5 flex flex-wrap items-end gap-3">
            <input type="hidden" name="orgId" value={org.id} />
            <div className="min-w-64 flex-1">
              <label className={labelClass}>Domain</label>
              <input name="domain" placeholder="portal.yourcompany.com" className={`mt-2 ${inputClass}`} required />
            </div>
            <button type="submit" className="btn-secondary">Request domain</button>
          </form>
        )}

        <div className="mt-5 space-y-4">
          {domains.length === 0 && <p className="text-sm text-white/40">No custom domains requested.</p>}
          {domains.map((domain) => (
            <div key={domain.id} className="rounded-xl border border-white/10 bg-white/[.02] p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-semibold">{domain.domain}</p>
                  <p className="mt-1 text-xs text-white/50">
                    {DOMAIN_STATUS_LABELS[domain.status]} · SSL: {domain.sslStatus.replace("_", " ")}
                    {domain.lastCheckedAt && ` · last checked ${new Date(domain.lastCheckedAt).toLocaleString()}`}
                  </p>
                  {domain.lastCheckError && domain.status === "pending_dns" && <p className="mt-1 text-xs text-amber-300">{domain.lastCheckError}</p>}
                </div>
                {canManage && (
                  <div className="flex gap-2">
                    {domain.status === "pending_dns" && (
                      <form action={verifyDomainAction}>
                        <input type="hidden" name="orgId" value={org.id} />
                        <input type="hidden" name="domainId" value={domain.id} />
                        <button type="submit" className="btn-secondary">Check DNS</button>
                      </form>
                    )}
                    <form action={removeDomainAction}>
                      <input type="hidden" name="orgId" value={org.id} />
                      <input type="hidden" name="domainId" value={domain.id} />
                      <button type="submit" className="rounded-full border border-red-400/40 px-4 py-2 text-xs font-bold text-red-400 hover:bg-red-400/10">Remove</button>
                    </form>
                  </div>
                )}
              </div>
              {domain.status !== "active" && (
                <div className="mt-4 overflow-x-auto rounded-lg border border-white/10">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-white/10 bg-white/[.03] uppercase tracking-wider text-white/50">
                      <tr><th className="px-3 py-2">Type</th><th className="px-3 py-2">Name</th><th className="px-3 py-2">Value</th></tr>
                    </thead>
                    <tbody>
                      {domain.requiredDns.map((record) => (
                        <tr key={record.type} className="border-b border-white/5 last:border-0">
                          <td className="px-3 py-2 font-bold">{record.type}</td>
                          <td className="px-3 py-2 font-mono">{record.name}</td>
                          <td className="px-3 py-2 font-mono break-all">{record.value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {domain.status === "verified" && <p className="mt-3 text-xs text-white/50">Verified. MogulForge will activate this domain and complete routing/SSL — contact support to schedule the cutover.</p>}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
