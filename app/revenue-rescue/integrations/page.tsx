import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

export const metadata: Metadata = {
  title: "Revenue Rescue Integrations — CRMs, Webhooks & Imports",
  description: "CRM and data integrations for Revenue Rescue with honest status labels: what's available today, what's in development, and what's coming soon.",
};

type Status = "Available" | "In development" | "Coming soon";

const integrations: { name: string; kind: string; status: Status; text: string }[] = [
  { name: "CSV import", kind: "Data import", status: "In development", text: "Upload lead exports from any system as CSV or Excel. Cleanup, deduplication, and scoring run automatically — arriving with the import pipeline." },
  { name: "Generic webhook", kind: "Data in/out", status: "In development", text: "Send leads in from any form, ad platform, or phone system; subscribe to reply, appointment, and stage events going out." },
  { name: "Generic REST API", kind: "Custom", status: "In development", text: "Tenant-scoped API access for custom software: push leads, pull opportunities, sync appointments." },
  { name: "GoHighLevel", kind: "CRM", status: "Coming soon", text: "Two-way contact and opportunity sync with pipeline-stage updates for agencies and contractors on GHL." },
  { name: "HubSpot", kind: "CRM", status: "Coming soon", text: "Contact import, opportunity pull, note sync, and stage updates through HubSpot's OAuth API." },
  { name: "JobNimbus", kind: "CRM", status: "Coming soon", text: "Contact and job sync built for roofing and exterior contractors running on JobNimbus." },
  { name: "ServiceTitan", kind: "CRM", status: "Coming soon", text: "Customer, estimate, and job-record sync for home-service companies on ServiceTitan." },
  { name: "Salesforce", kind: "CRM", status: "Coming soon", text: "Lead and opportunity synchronization for teams running Salesforce." },
  { name: "Buildertrend", kind: "CRM", status: "Coming soon", text: "Lead and proposal sync for builders and remodelers on Buildertrend." },
  { name: "Zapier", kind: "Automation", status: "Coming soon", text: "Connect Revenue Rescue events to thousands of apps once the public API and webhooks ship." },
  { name: "Make", kind: "Automation", status: "Coming soon", text: "Scenario-based automation using Revenue Rescue webhooks and API endpoints." },
  { name: "n8n", kind: "Automation", status: "Coming soon", text: "Self-hosted automation workflows driven by Revenue Rescue events." },
];

const statusStyle: Record<Status, string> = {
  Available: "border-forge-lime/50 bg-forge-lime/10 text-forge-lime",
  "In development": "border-forge-rust/40 bg-forge-rust/10 text-forge-rust",
  "Coming soon": "border-white/20 text-white/45",
};

export default function IntegrationsPage() {
  return <section className="shell py-16 sm:py-24">
    <div className="mx-auto max-w-4xl text-center">
      <p className="eyebrow">Integrations</p>
      <h1 className="mt-6 font-display text-5xl font-semibold leading-[.88] sm:text-7xl">Meet your leads where they live.</h1>
      <p className="mx-auto mt-7 max-w-2xl leading-7 text-white/60">Revenue Rescue is built on a provider-neutral integration framework: import contacts, sync opportunities, push stage updates, and process opt-outs across systems. Labels below reflect real status — nothing here is pretended into existence.</p>
    </div>

    <div className="mx-auto mt-10 flex max-w-6xl flex-wrap justify-center gap-4 text-xs">
      {(["Available", "In development", "Coming soon"] as Status[]).map(s => <span key={s} className={`rounded-full border px-3 py-1 font-extrabold uppercase tracking-wider ${statusStyle[s]}`}>{s}</span>)}
    </div>

    <div className="mx-auto mt-10 grid max-w-6xl gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {integrations.map(i => <article key={i.name} className="flex flex-col rounded-3xl border border-white/10 bg-white/[.03] p-6">
        <div className="flex items-start justify-between gap-3">
          <div><h2 className="font-extrabold">{i.name}</h2><p className="mt-1 text-[11px] font-bold uppercase tracking-wider text-white/35">{i.kind}</p></div>
          <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider ${statusStyle[i.status]}`}>{i.status}</span>
        </div>
        <p className="mt-4 text-sm leading-6 text-white/50">{i.text}</p>
      </article>)}
    </div>

    <div className="mx-auto mt-14 max-w-6xl rounded-3xl border border-white/10 bg-white/[.03] p-8 text-center sm:p-10">
      <h2 className="font-display text-4xl font-semibold">Don’t see your CRM?</h2>
      <p className="mx-auto mt-4 max-w-xl text-sm leading-6 text-white/55">Most systems can export a CSV — and that’s all a Revenue Rescue Sprint needs to start. Direct integrations are prioritized by client demand, so tell us what you run.</p>
      <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
        <Link href="/contact" className="btn-primary">Tell us your stack <ArrowRight size={16} /></Link>
        <Link href="/revenue-rescue/install" className="btn-secondary">See installation options</Link>
      </div>
    </div>
  </section>;
}
