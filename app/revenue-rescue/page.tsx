import type { Metadata } from "next";
import { RescueForm } from "@/components/rescue-form";
export const metadata: Metadata = { title: "AI Revenue Rescue Scan", description: "Find the conversion, visibility, and follow-up leaks costing your business revenue." };
export default function RevenueRescuePage(){return <section className="shell py-16 sm:py-24"><div className="mx-auto max-w-4xl text-center"><p className="eyebrow">AI Revenue Rescue™</p><h1 className="mt-6 font-display text-6xl font-semibold leading-[.86] sm:text-8xl">See where your revenue is escaping.</h1><p className="mx-auto mt-7 max-w-2xl leading-7 text-white/60">Answer eight questions. Get a first-pass score, prioritized leaks, and practical next moves in minutes.</p></div><div className="mx-auto mt-14 max-w-4xl"><RescueForm/></div></section>}

