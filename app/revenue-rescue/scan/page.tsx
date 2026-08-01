import type { Metadata } from "next";
import Link from "next/link";
import { RescueForm } from "@/components/rescue-form";

export const metadata: Metadata = {
  title: "AI Revenue Rescue Scan",
  description: "Find the conversion, visibility, and follow-up leaks costing your business revenue.",
};

export default function RevenueRescueScanPage() {
  return <section className="shell py-16 sm:py-24">
    <div className="mx-auto max-w-4xl text-center">
      <p className="eyebrow">AI Revenue Rescue™ Scan</p>
      <h1 className="mt-6 font-display text-6xl font-semibold leading-[.86] sm:text-8xl">See where your revenue is escaping.</h1>
      <p className="mx-auto mt-7 max-w-2xl leading-7 text-white/60">Answer eight questions. Get a first-pass score, prioritized leaks, and practical next moves in minutes.</p>
    </div>
    <div className="mx-auto mt-14 max-w-4xl"><RescueForm /></div>
    <p className="mx-auto mt-10 max-w-4xl text-center text-sm text-white/40">Want the full picture? <Link href="/revenue-rescue" className="border-b border-forge-lime/50 font-bold text-forge-lime">Explore Revenue Rescue</Link> or <Link href="/revenue-rescue/demo" className="border-b border-forge-lime/50 font-bold text-forge-lime">open the live demo</Link>.</p>
  </section>;
}
