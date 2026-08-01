import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Calculator, Database, MessageSquareText, Radar, Sparkles, Target } from "lucide-react";
import { exampleMetrics, pricingFactors, rescuePlans } from "@/lib/rescue-config";

export const metadata: Metadata = {
  title: "Revenue Rescue™ — Turn Old Leads Into Booked Jobs",
  description: "MogulForge Revenue Rescue analyzes your old estimates, missed calls, and dormant contacts, then helps turn overlooked opportunities into appointments and sold jobs.",
};

const problems = [
  "Leads were called only once.",
  "Estimates were never followed up.",
  "Website inquiries received slow responses.",
  "Missed calls were never recovered.",
  "Salespeople forgot to follow up.",
  "Projects were delayed and never revisited.",
  "Unsold proposals were buried in a CRM.",
  "Staff turnover erased lead history.",
  "Busy seasons left good opportunities neglected.",
];

const steps = [
  { n: "01", icon: Database, title: "Import", text: "Bring in what you already have: CRM exports, CSV and Excel files, website leads, missed calls, old estimates, unsold proposals, Facebook and Google Ads leads, and webhook events." },
  { n: "02", icon: Radar, title: "Analyze", text: "Records are cleaned and deduplicated, invalid info is flagged, opt-outs are suppressed, and every lead is categorized and scored for reactivation potential, estimated value, and the strongest outreach angle." },
  { n: "03", icon: MessageSquareText, title: "Reactivate", text: "Personalized SMS, emails, call scripts, voicemail scripts, estimate reminders, seasonal check-ins, and full follow-up sequences — prepared for your approval, not generic blasts." },
  { n: "04", icon: Target, title: "Convert", text: "Interested prospects are flagged hot, routed to your sales team, offered appointment times, tracked through estimate and job stages, and attributed to recovered pipeline and revenue." },
];

const faqs = [
  { q: "Is this another lead-generation service?", a: "No. Revenue Rescue works the leads you already paid for — old estimates, missed calls, dormant CRM contacts, and unsold proposals — instead of buying new traffic." },
  { q: "Are the dashboard numbers on this page real?", a: "No. Every metric on this page and the live demo is clearly labeled example data. Your dashboard is built from your own lead database after a Sprint." },
  { q: "Will it message my contacts without approval?", a: "No. Campaigns are prepared for your review, opt-outs are suppressed immediately, and high-value opportunities are flagged for manual approval." },
  { q: "What does it work with?", a: "CSV and spreadsheet imports plus native MogulForge websites today, with CRM connections, API, and webhook integrations in development. See the integrations page for honest status labels." },
  { q: "How do I start?", a: "With a Revenue Rescue Sprint: a one-time cleanup, analysis, and reactivation pass on your existing lead database. Book a call and we'll scope it against your data." },
];

export default function RevenueRescuePage() {
  return <>
    {/* Hero */}
    <section className="noise grid-lines overflow-hidden border-b border-white/10">
      <div className="shell relative py-20 sm:py-28">
        <div className="relative z-10 mx-auto max-w-5xl text-center">
          <p className="eyebrow">MogulForge Revenue Rescue™</p>
          <h1 className="mt-7 font-display text-[clamp(3.4rem,8vw,7.5rem)] font-semibold leading-[.82] tracking-[-.04em]">Your Old Leads Aren’t Dead. They’re <em className="font-normal text-forge-lime">Unworked Revenue.</em></h1>
          <p className="mx-auto mt-8 max-w-3xl leading-7 text-white/65 sm:text-lg">Revenue Rescue analyzes your old estimates, missed calls, website inquiries, unsold proposals, and dormant CRM contacts. It identifies the people most likely to re-engage, creates personalized follow-up, and helps turn overlooked opportunities into appointments and sold jobs.</p>
          <div className="mt-10 flex flex-col justify-center gap-3 sm:flex-row">
            <Link className="btn-primary" href="/contact">Start a Revenue Rescue Sprint <ArrowRight size={17} /></Link>
            <Link className="btn-secondary" href="/revenue-rescue/demo">Explore the Live Demo</Link>
          </div>
          <p className="mt-6 text-sm text-white/40">Not sure where you’re leaking? <Link href="/revenue-rescue/scan" className="border-b border-forge-lime/50 font-bold text-forge-lime">Run the free 2-minute leak scan</Link></p>
        </div>

        {/* Dashboard preview — example data */}
        <div className="relative z-10 mx-auto mt-16 max-w-5xl">
          <div className="rounded-[2rem] border border-white/15 bg-[#111815] p-4 shadow-2xl shadow-black/40">
            <div className="rounded-[1.5rem] border border-white/10 bg-forge-ink p-6 sm:p-9">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div><p className="eyebrow">Revenue Rescue Dashboard</p><p className="mt-1 text-sm text-white/45">What a reactivation quarter can look like</p></div>
                <span className="rounded-full border border-forge-rust/40 bg-forge-rust/10 px-3 py-1 text-xs font-extrabold uppercase tracking-wider text-forge-rust">Example data</span>
              </div>
              <div className="mt-8 grid gap-4 sm:grid-cols-3">
                {exampleMetrics.map(m => <div key={m.label} className="rounded-2xl border border-white/10 bg-white/[.03] p-5">
                  <p className="font-display text-4xl font-semibold text-forge-lime sm:text-5xl">{m.value}</p>
                  <p className="mt-2 text-xs font-bold uppercase tracking-wider text-white/45">{m.label}</p>
                </div>)}
              </div>
              <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-5 text-xs text-white/35">
                <span>Illustrative numbers — not live or client results.</span>
                <Link href="/revenue-rescue/demo" className="inline-flex items-center gap-1 font-extrabold text-forge-lime">Open the interactive demo <ArrowRight size={14} /></Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    {/* Problem */}
    <section className="shell py-24 sm:py-32">
      <div className="grid gap-12 lg:grid-cols-[.8fr_1.2fr]">
        <div>
          <p className="eyebrow">The expensive truth</p>
          <h2 className="mt-5 font-display text-5xl font-semibold leading-[.92] sm:text-7xl">You Already Paid for These Leads</h2>
          <p className="mt-8 max-w-md text-2xl leading-snug text-white/70">Most contractors don’t only have a lead-generation problem. <span className="text-forge-lime">They have a follow-up problem.</span></p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:content-start">
          {problems.map((p, i) => <div key={p} className="flex items-start gap-4 rounded-2xl border border-white/10 bg-white/[.03] p-5">
            <span className="text-xs font-bold text-forge-rust">{String(i + 1).padStart(2, "0")}</span>
            <p className="text-sm leading-6 text-white/60">{p}</p>
          </div>)}
        </div>
      </div>
    </section>

    {/* How it works */}
    <section className="bg-forge-moss py-24 sm:py-32">
      <div className="shell">
        <p className="eyebrow">How Revenue Rescue works</p>
        <h2 className="mt-5 max-w-3xl font-display text-5xl font-semibold leading-[.92] sm:text-6xl">From dead file to booked estimate in four steps.</h2>
        <div className="mt-14 grid border-y border-white/15 md:grid-cols-2 xl:grid-cols-4">
          {steps.map(({ n, icon: Icon, title, text }) => <div key={n} className="border-b border-white/15 py-9 md:px-8 md:[&:nth-child(odd)]:pl-0 xl:border-b-0 xl:border-r xl:first:pl-0 xl:last:border-r-0 xl:[&:nth-child(odd)]:pl-8">
            <div className="flex items-center justify-between"><span className="text-xs font-bold text-forge-lime">{n}</span><Icon className="text-forge-lime" size={20} /></div>
            <h3 className="mt-10 font-display text-4xl font-semibold">{title}</h3>
            <p className="mt-4 text-sm leading-6 text-white/55">{text}</p>
          </div>)}
        </div>
      </div>
    </section>

    {/* Calculator teaser */}
    <section className="bg-forge-cream py-24 text-forge-ink sm:py-32">
      <div className="shell grid gap-12 lg:grid-cols-2 lg:items-center">
        <div>
          <p className="eyebrow !text-forge-rust">Run your own numbers</p>
          <h2 className="mt-5 font-display text-5xl font-semibold leading-[.92] sm:text-7xl">What’s sitting in your dead file?</h2>
          <p className="mt-7 max-w-xl leading-7 text-black/60">Take your dormant lead count and average project value, apply conservative reactivation, booking, and close rates, and see the estimated revenue hiding in leads you already own.</p>
          <Link href="/revenue-rescue/calculator" className="btn-primary mt-9 !bg-forge-ink !text-white hover:!bg-black">Open the revenue calculator <Calculator size={17} /></Link>
        </div>
        <div className="rounded-[2rem] bg-forge-ink p-8 text-white sm:p-12">
          <p className="eyebrow">Example estimate</p>
          <div className="mt-8 space-y-4 text-sm">
            {[["1,000 dormant leads × 8% reactivation", "80 conversations"], ["80 conversations × 40% booking", "32 appointments"], ["32 appointments × 30% close", "≈10 projects"], ["10 projects × $12,000 average", ""]].map(([left, right]) => <div key={left} className="flex items-center justify-between gap-4 border-b border-white/10 pb-4"><span className="text-white/55">{left}</span><span className="font-extrabold text-forge-lime">{right}</span></div>)}
            <div className="flex items-end justify-between pt-2"><span className="text-white/55">Estimated recovered revenue</span><span className="font-display text-5xl font-semibold text-forge-lime">$115,200</span></div>
          </div>
          <p className="mt-6 text-xs text-white/35">Estimates only — not a guarantee. Results depend on your data quality and sales process.</p>
        </div>
      </div>
    </section>

    {/* Pricing */}
    <section id="pricing" className="shell py-24 sm:py-32">
      <div className="flex flex-col justify-between gap-6 md:flex-row md:items-end">
        <div><p className="eyebrow">Pricing</p><h2 className="mt-5 font-display text-5xl font-semibold sm:text-7xl">Priced like a system, not a subscription toy.</h2></div>
        <p className="max-w-md text-sm leading-6 text-white/50">Every plan starts with your existing lead database — not with buying more traffic. Starting prices shown; final pricing is scoped to your data.</p>
      </div>
      <div className="mt-14 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
        {rescuePlans.map(plan => <article key={plan.id} className={`flex flex-col rounded-3xl border p-7 ${plan.featured ? "border-forge-lime/50 bg-forge-lime/[.06]" : "border-white/10 bg-white/[.03]"}`}>
          {plan.featured && <span className="mb-4 inline-flex w-fit items-center gap-1 rounded-full bg-forge-lime px-3 py-1 text-[10px] font-extrabold uppercase tracking-wider text-forge-ink"><Sparkles size={12} /> Most popular</span>}
          {plan.cadence === "one-time" && <span className="mb-4 inline-flex w-fit rounded-full border border-forge-rust/40 bg-forge-rust/10 px-3 py-1 text-[10px] font-extrabold uppercase tracking-wider text-forge-rust">Start here</span>}
          <h3 className="text-lg font-extrabold">{plan.name}</h3>
          <p className="mt-3 text-sm leading-6 text-white/50">{plan.blurb}</p>
          <div className="mt-6"><span className="text-xs text-white/40">Starting at</span><div className="flex items-baseline gap-2"><span className="font-display text-5xl font-semibold text-forge-lime">${plan.price.toLocaleString()}</span><span className="text-xs text-white/40">{plan.cadence}</span></div></div>
          <ul className="mt-7 flex-1 space-y-2.5 border-t border-white/10 pt-6 text-sm text-white/60">{plan.features.map(f => <li key={f} className="flex gap-2.5"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-forge-lime" />{f}</li>)}</ul>
          <Link href="/contact" className={`${plan.featured || plan.cadence === "one-time" ? "btn-primary" : "btn-secondary"} mt-8 w-full`}>{plan.cadence === "one-time" ? "Start a Sprint" : "Talk to us"}</Link>
        </article>)}
      </div>
      <p className="mt-8 text-xs leading-6 text-white/35">Final pricing depends on: {pricingFactors.join(" · ")}.</p>
    </section>

    {/* FAQ */}
    <section className="border-t border-white/10 py-24 sm:py-32">
      <div className="shell grid gap-12 lg:grid-cols-[.7fr_1.3fr]">
        <div><p className="eyebrow">Straight answers</p><h2 className="mt-5 font-display text-5xl font-semibold leading-[.92] sm:text-6xl">Questions contractors actually ask.</h2></div>
        <div className="divide-y divide-white/10 border-y border-white/10">
          {faqs.map(f => <details key={f.q} className="group py-6">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-6 text-lg font-extrabold [&::-webkit-details-marker]:hidden">{f.q}<span className="text-forge-lime transition group-open:rotate-45">+</span></summary>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-white/55">{f.a}</p>
          </details>)}
        </div>
      </div>
    </section>

    {/* Final CTA */}
    <section className="bg-forge-lime text-forge-ink">
      <div className="shell grid gap-8 py-20 lg:grid-cols-[1fr_auto] lg:items-end">
        <div><p className="text-xs font-extrabold uppercase tracking-[.22em]">Your next move</p><h2 className="mt-5 max-w-4xl font-display text-5xl font-semibold leading-[.9] sm:text-7xl">We find the revenue hiding inside the leads you already paid for.</h2></div>
        <div className="flex flex-col gap-3 sm:flex-row lg:flex-col">
          <Link href="/contact" className="inline-flex items-center justify-center gap-3 rounded-full bg-forge-ink px-6 py-4 text-sm font-extrabold text-white">Start a Sprint <ArrowRight size={17} /></Link>
          <Link href="/revenue-rescue/demo" className="inline-flex items-center justify-center gap-3 rounded-full border-2 border-forge-ink px-6 py-4 text-sm font-extrabold">Explore the Live Demo</Link>
        </div>
      </div>
    </section>
  </>;
}
