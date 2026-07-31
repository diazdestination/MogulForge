import Link from "next/link";
import { ArrowRight } from "lucide-react";

export function CTA() { return <section className="bg-forge-lime text-forge-ink"><div className="shell grid gap-8 py-20 lg:grid-cols-[1fr_auto] lg:items-end"><div><p className="text-xs font-extrabold uppercase tracking-[.22em]">Your next move</p><h2 className="mt-5 max-w-4xl font-display text-5xl font-semibold leading-[.9] sm:text-7xl">Find the leak. Fix the system. Recover the revenue.</h2></div><Link href="/revenue-rescue" className="inline-flex items-center gap-3 rounded-full bg-forge-ink px-6 py-4 text-sm font-extrabold text-white">Run my scan <ArrowRight size={17} /></Link></div></section>; }

