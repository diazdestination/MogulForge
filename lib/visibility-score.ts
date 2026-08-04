import type { CrawlSignals } from "./visibility-crawler.ts";
import type { CategoryScore, VisibilityReport } from "./visibility-schema.ts";

function clamp(n: number): number { return Math.max(0, Math.min(100, Math.round(n))); }

export function scoreCategories(s: CrawlSignals): CategoryScore[] {
  const schemaFindings: string[] = [];
  let schema = 0;
  if (s.jsonLdTypes.length > 0) { schema += 60; schemaFindings.push(`Found JSON-LD structured data: ${s.jsonLdTypes.join(", ")}.`); }
  else schemaFindings.push("No JSON-LD structured data found — AI systems have no machine-readable description of the business.");
  if (s.jsonLdTypes.some((t) => /Organization|LocalBusiness|Person|Product|Service/i.test(t))) { schema += 25; schemaFindings.push("Entity-level schema (Organization/LocalBusiness or similar) is present."); }
  else schemaFindings.push("Missing entity schema such as Organization or LocalBusiness.");
  if (s.hasMicrodata) { schema += 5; schemaFindings.push("Microdata markup detected."); }
  if (s.jsonLdErrors > 0) { schema -= 15; schemaFindings.push(`${s.jsonLdErrors} JSON-LD block(s) failed to parse — broken markup is ignored by crawlers.`); }
  if (s.jsonLdTypes.length > 1) schema += 10;

  const crawlFindings: string[] = [];
  let crawl = 25;
  if (s.robotsTxt.found) crawlFindings.push("robots.txt is present.");
  else { crawl -= 10; crawlFindings.push("No robots.txt found."); }
  if (s.robotsTxt.blocksAll) { crawl -= 25; crawlFindings.push("robots.txt disallows all crawlers — the site is invisible to AI and search engines."); }
  if (s.robotsTxt.blockedAiBots.length > 0) crawlFindings.push(`AI crawlers explicitly blocked: ${s.robotsTxt.blockedAiBots.join(", ")}.`);
  else { crawl += 30; crawlFindings.push("No AI crawlers (GPTBot, ClaudeBot, PerplexityBot, etc.) are blocked."); }
  if (s.sitemap) { crawl += 25; crawlFindings.push("sitemap.xml is present and valid."); }
  else crawlFindings.push("No sitemap.xml found.");
  if (s.llmsTxt) { crawl += 20; crawlFindings.push("llms.txt is present — a strong signal for AI systems."); }
  else crawlFindings.push("No llms.txt file — an emerging standard that guides AI models to your key content.");
  if (s.robotsMetaNoindex) { crawl -= 40; crawlFindings.push("The page carries a noindex directive — it will not appear in search or AI answers."); }

  const metaFindings: string[] = [];
  let meta = 0;
  if (s.title) { meta += 25; metaFindings.push(`Title tag: “${s.title}”.`); } else metaFindings.push("Missing <title> tag.");
  if (s.metaDescription) { meta += 25; metaFindings.push("Meta description is present."); } else metaFindings.push("Missing meta description.");
  if (s.ogTags.length >= 3) { meta += 20; metaFindings.push(`Open Graph tags present (${s.ogTags.length}).`); } else metaFindings.push("Open Graph tags are missing or incomplete.");
  if (s.hasTwitterCard) { meta += 10; metaFindings.push("Twitter/X card metadata present."); }
  if (s.canonical) { meta += 10; metaFindings.push("Canonical URL is declared."); } else metaFindings.push("No canonical link tag.");
  if (s.htmlLang) { meta += 10; metaFindings.push(`Page language declared (${s.htmlLang}).`); } else metaFindings.push("No lang attribute on <html>.");

  const contentFindings: string[] = [];
  let content = 0;
  if (s.h1Count === 1) { content += 25; contentFindings.push("Exactly one H1 heading — clear topic signal."); }
  else if (s.h1Count === 0) contentFindings.push("No H1 heading found.");
  else { content += 10; contentFindings.push(`${s.h1Count} H1 headings — competing topic signals.`); }
  if (s.headingOutline.length >= 4) { content += 20; contentFindings.push("Structured heading outline detected."); } else contentFindings.push("Thin heading structure — AI systems rely on headings to understand page sections.");
  if (s.wordCount >= 300) { content += 20; contentFindings.push(`~${s.wordCount} words of readable text.`); } else contentFindings.push(`Only ~${s.wordCount} words of readable text — likely too thin for AI systems to cite.`);
  if (s.semanticTags.length >= 3) { content += 20; contentFindings.push(`Semantic HTML landmarks in use (${s.semanticTags.join(", ")}).`); } else contentFindings.push("Few semantic HTML landmarks (main, article, nav…).");
  if (s.imageCount > 0) {
    const ratio = s.imagesWithAlt / s.imageCount;
    if (ratio >= 0.8) { content += 15; contentFindings.push("Most images have alt text."); }
    else contentFindings.push(`Only ${s.imagesWithAlt}/${s.imageCount} images have alt text.`);
  } else content += 10;
  if (s.hasViewport) contentFindings.push("Mobile viewport is configured.");

  return [
    { name: "Schema & structured data", score: clamp(schema), findings: schemaFindings },
    { name: "AI crawlability", score: clamp(crawl), findings: crawlFindings },
    { name: "Metadata", score: clamp(meta), findings: metaFindings },
    { name: "Content structure", score: clamp(content), findings: contentFindings },
  ];
}

export function overallScore(categories: CategoryScore[]): number {
  const weights: Record<string, number> = { "Schema & structured data": 0.3, "AI crawlability": 0.3, "Metadata": 0.2, "Content structure": 0.2 };
  return clamp(categories.reduce((sum, c) => sum + c.score * (weights[c.name] ?? 0.25), 0));
}

export function fallbackReport(s: CrawlSignals, categories: CategoryScore[]): VisibilityReport {
  const score = overallScore(categories);
  const weakest = [...categories].sort((a, b) => a.score - b.score);
  const recs = weakest.slice(0, 3).map((c) => ({
    title: `Strengthen ${c.name.toLowerCase()}`,
    why: c.findings.find((f) => /no |missing|only|blocked|thin|few|fail/i.test(f)) ?? `${c.name} is the weakest part of your AI visibility profile.`,
    fix: c.name === "Schema & structured data" ? "Add JSON-LD Organization/LocalBusiness and Service schema to your key pages."
      : c.name === "AI crawlability" ? "Publish a sitemap.xml and an llms.txt, and make sure robots.txt does not block AI crawlers."
      : c.name === "Metadata" ? "Add a compelling title, meta description, canonical link, and Open Graph tags to every page."
      : "Use one clear H1, a logical heading outline, semantic HTML landmarks, and descriptive alt text.",
  }));
  return {
    score,
    categories,
    recommendations: recs,
    summary: `This first-pass scan of ${s.finalUrl} scored ${score}/100 for AI visibility. The signals above are measured directly from your live site; the biggest gains are in ${weakest[0].name.toLowerCase()}.`,
  };
}
