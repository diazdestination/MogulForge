import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { RescueForm } from "@/components/rescue-form";

export const metadata: Metadata = {
  title: "AI Revenue Rescue Scan",
  description:
    "Find the conversion, visibility, and follow-up leaks costing your business revenue.",
};

const leaks = ["Slow lead response", "Weak conversion path", "AI search blind spot"];

export default function RevenueRescuePage() {
  return (
    <>
      <section className="noise grid-lines overflow-hidden border-b border-white/10">
        <div className="shell relative grid min-h-[calc(100vh-76px)] gap-12 py-16 lg:grid-cols-[1.15fr_.85fr] lg:items-center lg:py-24">
          <div className="relative z-10">
            <p className="eyebrow">Introducing AI Revenue Rescue™</p>
            <h1 className="mt-7 max-w-5xl font-display text-[clamp(4.2rem,9vw,9rem)] font-semibold leading-[.75] tracking-[-.055em]">
              Stop losing <em className="font-normal text-forge-lime">revenue</em> you already earned.
            </h1>
            <p className="mt-8 max-w-2xl text-base leading-7 text-white/65 sm:text-lg">
              We expose the hidden leaks costing your business leads, sales, and repeat customers—then forge the systems that recover them.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Link className="btn-primary" href="#scan">
                Run my Revenue Rescue Scan <ArrowRight size={17} />
              </Link>
              <Link className="btn-secondary" href="/#growthos">
                Explore GrowthOS
              </Link>
            </div>
          </div>

          <div className="relative z-10 lg:pl-8">
            <div className="mx-auto max-w-md rotate-2 rounded-[2rem] border border-white/15 bg-[#111815] p-4 shadow-2xl shadow-black/40">
              <div className="rounded-[1.5rem] border border-white/10 bg-forge-ink p-7">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="eyebrow">Revenue Rescue Score</p>
                    <p className="mt-2 text-sm text-white/45">Opportunity snapshot</p>
                  </div>
                  <span className="shrink-0 rounded-full bg-forge-rust/15 px-3 py-1 text-xs font-bold text-forge-rust">
                    Revenue at risk
                  </span>
                </div>
                <div className="mt-10 flex items-end gap-3">
                  <span className="font-display text-8xl font-semibold leading-none">64</span>
                  <span className="pb-3 text-white/35">/100</span>
                </div>
                <div className="mt-8 h-2 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full w-[64%] rounded-full bg-gradient-to-r from-forge-rust to-forge-lime" />
                </div>
                <div className="mt-8 space-y-4">
                  {leaks.map((item, index) => (
                    <div key={item} className="flex items-center justify-between gap-4 border-t border-white/10 pt-4 text-sm">
                      <span className="text-white/65">0{index + 1} &nbsp; {item}</span>
                      <span className="text-forge-lime">Fixable</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="bg-forge-cream py-6 text-forge-ink">
        <div className="shell flex flex-wrap items-center justify-between gap-4 text-xs font-extrabold uppercase tracking-[.16em]">
          <span>More visibility</span><span className="text-black/20">✦</span>
          <span>Faster follow-up</span><span className="text-black/20">✦</span>
          <span>Higher conversion</span><span className="text-black/20">✦</span>
          <span>Recovered revenue</span>
        </div>
      </section>

      <section id="scan" className="shell scroll-mt-24 py-20 sm:py-28">
        <div className="mx-auto max-w-4xl text-center">
          <p className="eyebrow">Your first-pass diagnosis</p>
          <h2 className="mt-6 font-display text-5xl font-semibold leading-[.9] sm:text-7xl">
            See where your revenue is escaping.
          </h2>
          <p className="mx-auto mt-7 max-w-2xl leading-7 text-white/60">
            Answer eight questions. Get a first-pass score, prioritized leaks, and practical next moves in minutes.
          </p>
        </div>
        <div className="mx-auto mt-14 max-w-4xl">
          <RescueForm />
        </div>
      </section>
    </>
  );
}
