import type { Metadata } from "next";
import { VisibilityForm } from "@/components/visibility-form";

export const metadata: Metadata = { title: "AI Visibility Scan", description: "See how visible your website is to AI search — schema, crawlability, metadata, and content structure, scored in minutes." };

const checks = [
  { title: "Schema & structured data", body: "We look for JSON-LD and entity markup that tells AI systems exactly who you are and what you sell." },
  { title: "AI crawlability", body: "We check robots.txt for blocked AI crawlers like GPTBot and PerplexityBot, plus sitemap.xml and llms.txt." },
  { title: "Metadata", body: "Titles, descriptions, canonical links, and Open Graph tags — the signals AI uses to summarize and cite you." },
  { title: "Content structure", body: "Headings, semantic HTML, readable text depth, and alt text that make your pages quotable by AI answers." },
];

export default function AiVisibilityPage() {
  return <section className="shell py-16 sm:py-24">
    <div className="mx-auto max-w-4xl text-center">
      <p className="eyebrow">AI Visibility Scan</p>
      <h1 className="mt-6 font-display text-6xl font-semibold leading-[.86] sm:text-8xl">Can AI even find you?</h1>
      <p className="mx-auto mt-7 max-w-2xl leading-7 text-white/60">ChatGPT, Perplexity, and Google AI now answer your customers directly. Enter your website and we&rsquo;ll crawl it live, score its AI readiness, and show you exactly what to fix.</p>
    </div>
    <div className="mx-auto mt-14 max-w-4xl"><VisibilityForm /></div>
    <div className="mx-auto mt-16 grid max-w-4xl gap-4 sm:grid-cols-2">
      {checks.map((c) => <div key={c.title} className="rounded-xl border border-white/10 bg-white/[.02] p-6">
        <h2 className="font-extrabold">{c.title}</h2>
        <p className="mt-2 text-sm leading-6 text-white/50">{c.body}</p>
      </div>)}
    </div>
  </section>;
}
