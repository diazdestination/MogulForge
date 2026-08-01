import type { Metadata } from "next";
import { CTA } from "@/components/cta";
export const metadata: Metadata = {
  title: "Why MogulForge",
  description: "MogulForge exists for ambitious businesses whose real-world reputation has outgrown their digital systems. Diagnose before prescribing. Prioritize leverage.",
};
export default function AboutPage(){ return <><section className="shell grid gap-12 py-20 sm:py-28 lg:grid-cols-2"><div><p className="eyebrow">Why MogulForge</p><h1 className="mt-6 font-display text-6xl font-semibold leading-[.86] sm:text-8xl">Growth should feel engineered—not improvised.</h1></div><div className="space-y-8 text-lg leading-8 text-white/60 lg:pt-16"><p>MogulForge exists for ambitious businesses whose real-world reputation has outgrown their digital systems.</p><p>We combine sharp positioning, conversion design, search visibility, and practical automation into one recovery-minded process. The goal is not to sell more software. It is to build a business journey that loses fewer good opportunities.</p><p className="font-bold text-white">Diagnose before prescribing. Prioritize leverage. Build for the person on the other side of the screen.</p></div></section><CTA/></> }

