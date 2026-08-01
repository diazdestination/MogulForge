import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { isPlatformAdmin } from "@/lib/admin-auth";
import { getCurrentUser } from "@/lib/auth";
import { listPlanDefinitions, upsertPlanDefinition } from "@/lib/subscriptions";
import { getBillingAdapter } from "@/lib/billing";
import { USAGE_METRIC_LABELS, isUsageMetric, type LimitSet } from "@/lib/usage-metrics";
import { logAudit } from "@/lib/audit";

export const metadata: Metadata = { title: "Subscriptions & Pricing — Admin", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const LIMIT_KEYS = ["seats", "leads_stored", "leads_imported", "ai_jobs", "messages_generated", "sms_sent", "emails_sent", "api_requests"] as const;

function limitLabel(key: string): string {
  if (key === "seats") return "Seats";
  return isUsageMetric(key) ? USAGE_METRIC_LABELS[key] : key;
}

async function savePlanAction(formData: FormData) {
  "use server";
  if (!(await isPlatformAdmin())) redirect("/admin/login?next=/admin/subscriptions");
  const id = String(formData.get("planId") ?? "").trim();
  if (!id) redirect("/admin/subscriptions");

  const limits: LimitSet = {};
  for (const key of LIMIT_KEYS) {
    const raw = String(formData.get(`limit_${key}`) ?? "").trim();
    if (raw === "") continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) limits[key] = Math.floor(value);
  }

  const priceRaw = Number(String(formData.get("price") ?? "0").replace(/[^0-9.]/g, ""));
  await upsertPlanDefinition({
    id,
    name: String(formData.get("name") ?? "").trim().slice(0, 120) || id,
    blurb: String(formData.get("blurb") ?? "").trim().slice(0, 300),
    price: Number.isFinite(priceRaw) && priceRaw >= 0 ? priceRaw : 0,
    cadence: String(formData.get("cadence")) === "one-time" ? "one-time" : "per month",
    features: String(formData.get("features") ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 20),
    limits,
    featured: formData.get("featured") === "on",
    isPublic: formData.get("isPublic") === "on",
    sortOrder: Math.floor(Number(formData.get("sortOrder") ?? 0)) || 0,
  });

  const user = await getCurrentUser();
  await logAudit({
    organizationId: null,
    actorUserId: user?.id ?? null,
    actorLabel: user?.email ?? "platform-admin (password)",
    action: "plan_definition.updated",
    targetType: "plan_definition",
    targetId: id,
  });
  redirect("/admin/subscriptions");
}

export default async function AdminSubscriptionsPage() {
  if (!(await isPlatformAdmin())) redirect("/admin/login?next=/admin/subscriptions");
  const plans = await listPlanDefinitions();
  const adapter = getBillingAdapter(process.env.BILLING_PROVIDER);
  const inputClass = "w-full rounded-xl border border-white/10 bg-white/[.04] px-3 py-2 text-sm outline-none focus:border-forge-lime/50";
  const labelClass = "block text-xs font-bold uppercase tracking-wider text-white/50";

  return <section className="shell py-16">
    <div className="mx-auto max-w-6xl">
      <p className="eyebrow"><Link href="/admin/organizations" className="hover:underline">MogulForge Admin</Link> / Subscriptions & pricing</p>
      <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl font-semibold">Subscriptions & pricing</h1>
          <p className="mt-2 max-w-2xl text-sm text-white/50">
            Public plans power the pricing cards on the Revenue Rescue page the moment you save. Limits gate imports,
            AI runs, sends, and API traffic server-side — leave a limit blank for unlimited.
          </p>
        </div>
        <Link href="/admin/usage" className="btn-secondary">Usage console</Link>
      </div>

      <div className="mt-6 rounded-xl border border-white/10 bg-white/[.02] px-5 py-4 text-sm text-white/60">
        <span className="font-bold text-white/80">Billing adapter:</span> {adapter.provider} — {adapter.description}{" "}
        <span className="text-white/40">Swap providers later by registering a new adapter; no plan or org data changes.</span>
      </div>

      <div className="mt-10 space-y-8">
        {plans.map((plan) => <form key={plan.id} action={savePlanAction} className="rounded-xl border border-white/10 bg-white/[.02] p-6">
          <input type="hidden" name="planId" value={plan.id} />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-2xl font-semibold">{plan.name} <span className="ml-2 text-sm font-normal text-white/40">{plan.id}</span></h2>
            <div className="flex items-center gap-4 text-xs text-white/60">
              <label className="flex items-center gap-2"><input type="checkbox" name="isPublic" defaultChecked={plan.isPublic} /> Public pricing card</label>
              <label className="flex items-center gap-2"><input type="checkbox" name="featured" defaultChecked={plan.featured} /> Featured</label>
            </div>
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div><label className={labelClass}>Name</label><input name="name" defaultValue={plan.name} className={`mt-2 ${inputClass}`} /></div>
                <div><label className={labelClass}>Sort order</label><input name="sortOrder" type="number" defaultValue={plan.sortOrder} className={`mt-2 ${inputClass}`} /></div>
                <div><label className={labelClass}>Price (USD)</label><input name="price" defaultValue={plan.price} className={`mt-2 ${inputClass}`} /></div>
                <div><label className={labelClass}>Cadence</label>
                  <select name="cadence" defaultValue={plan.cadence} className={`mt-2 ${inputClass}`}>
                    <option value="per month">per month</option>
                    <option value="one-time">one-time</option>
                  </select>
                </div>
              </div>
              <div><label className={labelClass}>Blurb</label><input name="blurb" defaultValue={plan.blurb} className={`mt-2 ${inputClass}`} /></div>
              <div><label className={labelClass}>Features (one per line)</label><textarea name="features" rows={5} defaultValue={plan.features.join("\n")} className={`mt-2 ${inputClass}`} /></div>
            </div>
            <div>
              <label className={labelClass}>Usage limits (blank = unlimited)</label>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                {LIMIT_KEYS.map((key) => <div key={key}>
                  <label className="block text-xs text-white/50">{limitLabel(key)}</label>
                  <input name={`limit_${key}`} type="number" min={0} defaultValue={plan.limits[key] ?? ""} className={`mt-1 ${inputClass}`} />
                </div>)}
              </div>
            </div>
          </div>
          <button type="submit" className="btn-secondary mt-5">Save {plan.name}</button>
        </form>)}
      </div>
    </div>
  </section>;
}
