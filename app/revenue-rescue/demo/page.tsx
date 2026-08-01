import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { RescueDemoDashboard } from "@/components/rescue-demo-dashboard";

export const metadata: Metadata = {
  title: "Revenue Rescue Live Demo — Example Dashboard",
  description: "Explore an interactive Revenue Rescue dashboard built entirely from labeled demo data: lead journeys, campaigns, appointments, and recovered pipeline.",
};

export default function DemoPage() {
  return <section className="shell py-14 sm:py-20">
    <div className="mx-auto max-w-4xl text-center">
      <div className="inline-flex items-center gap-2 rounded-full border border-forge-rust/40 bg-forge-rust/10 px-4 py-1.5 text-xs font-extrabold uppercase tracking-wider text-forge-rust">Live demo · 100% example data</div>
      <h1 className="mt-6 font-display text-5xl font-semibold leading-[.88] sm:text-7xl">This is what worked leads look like.</h1>
      <p className="mx-auto mt-6 max-w-2xl leading-7 text-white/60">A read-only preview of the Revenue Rescue dashboard for a fictional contractor, “Sunline Exteriors.” Every lead, message, and dollar figure below is demo data — click through the tabs to see full lead journeys, campaigns, and activity.</p>
    </div>
    <div className="mx-auto mt-12 max-w-6xl"><RescueDemoDashboard /></div>
    <div className="mx-auto mt-12 flex max-w-4xl flex-col items-center gap-4 text-center">
      <p className="max-w-xl text-sm leading-6 text-white/45">Your dashboard gets built from your own lead database during a Revenue Rescue Sprint — imported, cleaned, scored, and ready to work.</p>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Link href="/contact" className="btn-primary">Start a Revenue Rescue Sprint <ArrowRight size={16} /></Link>
        <Link href="/revenue-rescue/calculator" className="btn-secondary">Run your own numbers</Link>
      </div>
    </div>
  </section>;
}
