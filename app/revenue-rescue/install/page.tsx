import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Code2, Globe, LayoutDashboard, Webhook } from "lucide-react";

export const metadata: Metadata = {
  title: "Install Revenue Rescue — Native Pages, Embeds, API & Webhooks",
  description: "How Revenue Rescue installs into your website or CRM: native MogulForge routes, secure embedded dashboards, REST API, and webhooks — with honest status labels.",
};

const options = [
  {
    icon: Globe,
    title: "Native Revenue Rescue pages",
    status: "Available",
    text: "For websites and CRMs built by MogulForge, Revenue Rescue ships as native routes inside your existing site — same domain, same branding, no iframes. The pages connect to the central MogulForge platform, so your site never carries its own copy of the product.",
    detail: "Best for: MogulForge-built websites and client portals.",
  },
  {
    icon: LayoutDashboard,
    title: "Secure embedded dashboard",
    status: "In development",
    text: "A script-tag embed that renders your Revenue Rescue dashboard inside any website you control. Your backend requests a short-lived signed session from MogulForge; no permanent credentials ever live in browser code, and every call revalidates user, tenant, origin, and expiration.",
    detail: "Best for: existing websites and CRMs not built by MogulForge.",
    code: `<script\n  src="https://embed.mogulforge.ai/revenue-rescue.js"\n  data-container="mogulforge-revenue-rescue"\n  data-module="dashboard">\n</script>\n<div id="mogulforge-revenue-rescue"></div>`,
  },
  {
    icon: Code2,
    title: "REST API",
    status: "In development",
    text: "A tenant-scoped REST API for pushing leads in, pulling opportunities and appointments out, and wiring Revenue Rescue data into your own tools. Authenticated with organization API keys kept strictly server-side.",
    detail: "Best for: custom software and internal tools.",
  },
  {
    icon: Webhook,
    title: "Incoming & outgoing webhooks",
    status: "In development",
    text: "Send new leads to Revenue Rescue from any form, ad platform, or phone system via a signed incoming webhook — and subscribe to outgoing events like replies, appointments, and stage changes to keep your CRM in sync.",
    detail: "Best for: connecting form builders, ad platforms, and automation tools.",
  },
];

const statusStyle: Record<string, string> = {
  Available: "border-forge-lime/50 bg-forge-lime/10 text-forge-lime",
  "In development": "border-forge-rust/40 bg-forge-rust/10 text-forge-rust",
  "Coming soon": "border-white/20 text-white/45",
};

export default function InstallPage() {
  return <>
    <section className="shell py-16 sm:py-24">
      <div className="mx-auto max-w-4xl text-center">
        <p className="eyebrow">Install Revenue Rescue</p>
        <h1 className="mt-6 font-display text-5xl font-semibold leading-[.88] sm:text-7xl">One platform. Four ways in.</h1>
        <p className="mx-auto mt-7 max-w-2xl leading-7 text-white/60">Revenue Rescue runs as a central MogulForge platform — your website or CRM connects to it instead of hosting its own copy. Choose the installation path that fits how your business is built. Status labels below are honest: we don’t claim an integration works before it does.</p>
      </div>

      <div className="mx-auto mt-14 grid max-w-6xl gap-5 lg:grid-cols-2">
        {options.map(({ icon: Icon, title, status, text, detail, code }) => <article key={title} className="flex flex-col rounded-3xl border border-white/10 bg-white/[.03] p-7 sm:p-8">
          <div className="flex items-start justify-between gap-4">
            <Icon className="text-forge-lime" />
            <span className={`rounded-full border px-3 py-1 text-[10px] font-extrabold uppercase tracking-wider ${statusStyle[status]}`}>{status}</span>
          </div>
          <h2 className="mt-7 text-xl font-extrabold">{title}</h2>
          <p className="mt-3 text-sm leading-6 text-white/55">{text}</p>
          {code && <pre className="mt-5 overflow-x-auto rounded-xl border border-white/10 bg-black/40 p-4 text-xs leading-5 text-forge-lime/80"><code>{code}</code></pre>}
          <p className="mt-5 border-t border-white/10 pt-4 text-xs font-bold text-white/40">{detail}</p>
        </article>)}
      </div>

      <div className="mx-auto mt-14 max-w-6xl rounded-3xl border border-white/10 bg-forge-moss/60 p-8 sm:p-10">
        <div className="grid gap-8 lg:grid-cols-[1fr_auto] lg:items-center">
          <div>
            <h2 className="font-display text-4xl font-semibold">Not sure which path fits?</h2>
            <p className="mt-4 max-w-2xl text-sm leading-6 text-white/60">Every Revenue Rescue engagement starts with a Sprint on your existing lead database — installation comes after we’ve proven there’s revenue worth recovering. We’ll recommend the right integration path during scoping.</p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Link href="/contact" className="btn-primary">Talk to us <ArrowRight size={16} /></Link>
            <Link href="/revenue-rescue/integrations" className="btn-secondary">See CRM integrations</Link>
          </div>
        </div>
      </div>
    </section>
  </>;
}
