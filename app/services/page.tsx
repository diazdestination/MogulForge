import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { CTA } from "@/components/cta";

export const metadata: Metadata = { title: "Revenue Recovery Services", description: "Conversion websites, lead recovery automation, AI search visibility, and custom growth systems." };
const items = [
  { id:"01", title:"Revenue Rescue Website", lead:"A website should do more than look credible. It should make the next step obvious.", points:["Conversion strategy and messaging","Premium responsive design","Local and technical SEO foundations","Analytics and lead attribution"] },
  { id:"02", title:"Lead Recovery Automation", lead:"The first useful response often wins. We make sure yours arrives.", points:["Missed-call text back","Instant form response","Estimate and pipeline follow-up","Review and reactivation campaigns"] },
  { id:"03", title:"AI Search Visibility", lead:"Be the business customers discover whether they ask Google, maps, or an AI assistant.", points:["Local search optimization","Answer-engine content structure","Entity and reputation signals","Technical discoverability"] },
  { id:"04", title:"Custom Growth Systems", lead:"When an off-the-shelf tool cannot match your workflow, we build the missing piece.", points:["Internal dashboards","Qualified-lead tools","Workflow integrations","AI-assisted operations"] },
];
export default function ServicesPage(){ return <><section className="shell py-20 sm:py-28"><p className="eyebrow">Revenue recovery services</p><h1 className="mt-6 max-w-5xl font-display text-6xl font-semibold leading-[.85] sm:text-8xl">Build less. Recover more.</h1><p className="mt-8 max-w-2xl text-lg leading-8 text-white/60">We start with the leak, then install the smallest high-leverage system that closes it.</p></section><section className="border-t border-white/10">{items.map(item => <article id={item.id} key={item.id} className="shell grid gap-8 border-b border-white/10 py-16 lg:grid-cols-[.7fr_1.3fr]"><div><span className="text-xs font-bold text-forge-lime">{item.id}</span><h2 className="mt-6 font-display text-4xl font-semibold sm:text-6xl">{item.title}</h2></div><div><p className="max-w-2xl text-2xl leading-snug text-white/70">{item.lead}</p><div className="mt-9 grid gap-3 sm:grid-cols-2">{item.points.map(p => <div key={p} className="rounded-xl border border-white/10 p-4 text-sm text-white/55">{p}</div>)}</div><Link href="/contact" className="mt-8 inline-flex items-center gap-2 text-sm font-extrabold text-forge-lime">Talk strategy <ArrowRight size={16}/></Link></div></article>)}</section><CTA/></> }

