import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { isPlatformAdmin } from "@/lib/admin-auth";
import { getCurrentUser } from "@/lib/auth";
import { provisionOrganization } from "@/lib/provisioning";
import { FEATURE_KEYS, FEATURE_LABELS, isFeatureKey, type FeatureKey } from "@/lib/entitlements";
import { PLANS, PLAN_LABELS, PLAN_DEFAULTS, isPlan, type UsageLimits } from "@/lib/plans";

export const metadata: Metadata = { title: "Provision client — Admin", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const LIMIT_FIELDS: { key: keyof UsageLimits; label: string }[] = [
  { key: "seats", label: "Seats" },
  { key: "leads_per_month", label: "Leads / month" },
  { key: "ai_analyses_per_month", label: "AI analyses / month" },
  { key: "sms_per_month", label: "SMS / month" },
  { key: "emails_per_month", label: "Emails / month" },
];

async function provisionAction(formData: FormData) {
  "use server";
  if (!(await isPlatformAdmin())) redirect("/admin/login?next=/admin/provision-client");
  const user = await getCurrentUser();
  const actorLabel = user?.platformRole ? `${user.email} (${user.platformRole})` : "platform-admin (password)";

  const name = String(formData.get("name") ?? "").trim();
  const ownerEmail = String(formData.get("ownerEmail") ?? "").trim();
  const planRaw = String(formData.get("plan") ?? "starter");
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail) || !isPlan(planRaw)) {
    redirect("/admin/provision-client?error=" + encodeURIComponent("Company name, a valid plan, and a valid owner email are required."));
  }
  const modules = formData.getAll("modules").map(String).filter(isFeatureKey) as FeatureKey[];
  const usageLimits: Partial<UsageLimits> = {};
  for (const field of LIMIT_FIELDS) {
    const raw = String(formData.get(`limit_${field.key}`) ?? "").trim();
    if (raw !== "" && Number.isFinite(Number(raw))) usageLimits[field.key] = Math.max(0, Math.floor(Number(raw)));
  }
  const allowedOrigins = String(formData.get("allowedOrigins") ?? "")
    .split(/[\n,]/)
    .map((origin) => origin.trim())
    .filter(Boolean);

  const result = await provisionOrganization(
    {
      name,
      slug: String(formData.get("slug") ?? "").trim() || undefined,
      industry: String(formData.get("industry") ?? "").trim() || null,
      timezone: String(formData.get("timezone") ?? "").trim() || undefined,
      plan: planRaw,
      modules,
      usageLimits,
      brandPrimaryColor: String(formData.get("brandPrimaryColor") ?? "").trim() || null,
      brandSecondaryColor: String(formData.get("brandSecondaryColor") ?? "").trim() || null,
      logoUrl: String(formData.get("logoUrl") ?? "").trim() || null,
      allowedOrigins,
      owner: { email: ownerEmail, name: String(formData.get("ownerName") ?? "").trim() || null },
    },
    { userId: user?.id ?? null, label: actorLabel },
  );
  redirect(`/admin/organizations/${result.organizationId}/install-kit`);
}

const inputClass = "w-full rounded-xl border border-white/10 bg-white/[.04] px-4 py-3 text-sm outline-none focus:border-forge-lime/50";
const labelClass = "block text-xs font-bold uppercase tracking-wider text-white/50";

export default async function ProvisionClientPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (!(await isPlatformAdmin())) redirect("/admin/login?next=/admin/provision-client");
  const { error } = await searchParams;
  const growthDefaults = PLAN_DEFAULTS.growth;
  return <section className="shell py-16">
    <div className="mx-auto max-w-3xl">
      <p className="eyebrow">MogulForge Admin</p>
      <h1 className="mt-4 font-display text-4xl font-semibold">Provision a new client</h1>
      <p className="mt-2 text-sm text-white/50">Creates the organization, enables its modules, sets usage limits, and generates the owner&rsquo;s invite — no code changes needed. <Link href="/admin/organizations" className="text-forge-lime hover:underline">Back to organizations</Link></p>
      {error && <p className="mt-4 rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-300">{error}</p>}
      <form action={provisionAction} className="mt-10 space-y-10">
        <fieldset className="space-y-4">
          <legend className="font-display text-2xl font-semibold">Company</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <div><label className={labelClass}>Company name *</label><input name="name" required className={`mt-2 ${inputClass}`} placeholder="Acme Roofing Co." /></div>
            <div><label className={labelClass}>Slug (optional)</label><input name="slug" className={`mt-2 ${inputClass}`} placeholder="acme-roofing" /></div>
            <div><label className={labelClass}>Industry</label><input name="industry" className={`mt-2 ${inputClass}`} placeholder="Roofing" /></div>
            <div><label className={labelClass}>Timezone</label><input name="timezone" defaultValue="America/New_York" className={`mt-2 ${inputClass}`} /></div>
          </div>
        </fieldset>

        <fieldset className="space-y-4">
          <legend className="font-display text-2xl font-semibold">Plan &amp; modules</legend>
          <div><label className={labelClass}>Plan</label>
            <select name="plan" defaultValue="growth" className={`mt-2 ${inputClass}`}>
              {PLANS.map((plan) => <option key={plan} value={plan}>{PLAN_LABELS[plan]}</option>)}
            </select>
          </div>
          <div>
            <p className={labelClass}>Enabled modules (server-enforced entitlements)</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {FEATURE_KEYS.map((key) => <label key={key} className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[.03] px-4 py-3 text-sm">
                <input type="checkbox" name="modules" value={key} defaultChecked={growthDefaults.modules.includes(key)} className="h-4 w-4 accent-[#c8f04a]" />
                {FEATURE_LABELS[key]}
              </label>)}
            </div>
          </div>
        </fieldset>

        <fieldset className="space-y-4">
          <legend className="font-display text-2xl font-semibold">Usage limits</legend>
          <div className="grid gap-4 sm:grid-cols-3">
            {LIMIT_FIELDS.map((field) => <div key={field.key}>
              <label className={labelClass}>{field.label}</label>
              <input name={`limit_${field.key}`} type="number" min={0} defaultValue={growthDefaults.limits[field.key]} className={`mt-2 ${inputClass}`} />
            </div>)}
          </div>
        </fieldset>

        <fieldset className="space-y-4">
          <legend className="font-display text-2xl font-semibold">Initial owner</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <div><label className={labelClass}>Owner email *</label><input name="ownerEmail" type="email" required className={`mt-2 ${inputClass}`} placeholder="owner@acmeroofing.com" /></div>
            <div><label className={labelClass}>Owner name</label><input name="ownerName" className={`mt-2 ${inputClass}`} placeholder="Alex Acme" /></div>
          </div>
        </fieldset>

        <fieldset className="space-y-4">
          <legend className="font-display text-2xl font-semibold">Branding &amp; origins</legend>
          <div className="grid gap-4 sm:grid-cols-3">
            <div><label className={labelClass}>Primary color</label><input name="brandPrimaryColor" className={`mt-2 ${inputClass}`} placeholder="#c8f04a" /></div>
            <div><label className={labelClass}>Secondary color</label><input name="brandSecondaryColor" className={`mt-2 ${inputClass}`} placeholder="#0e0f0c" /></div>
            <div><label className={labelClass}>Logo URL</label><input name="logoUrl" className={`mt-2 ${inputClass}`} placeholder="https://…/logo.png" /></div>
          </div>
          <div>
            <label className={labelClass}>Allowed origins (one per line — for embeds/API later)</label>
            <textarea name="allowedOrigins" rows={3} className={`mt-2 ${inputClass}`} placeholder={"https://acmeroofing.com\nhttps://www.acmeroofing.com"} />
          </div>
        </fieldset>

        <button type="submit" className="btn-primary">Provision organization</button>
      </form>
    </div>
  </section>;
}
