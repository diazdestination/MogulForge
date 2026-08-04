// Pure, unit-testable parsing helpers for the visibility crawler.
// No "server-only" import — safe to load under node --test.

export const AI_BOTS = ["GPTBot", "ClaudeBot", "Claude-Web", "PerplexityBot", "Google-Extended", "CCBot", "anthropic-ai", "Bytespider"];

import { isIP } from "node:net";

export function isPrivateIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts;
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fe80") || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("ff")) return true;
    if (lower.startsWith("::ffff:")) return isPrivateIp(lower.slice(7));
    return false;
  }
  return true;
}

export function isPrivateHostname(hostname: string): boolean {
  return /^(localhost|.*\.(localhost|local|internal|home\.arpa))$/i.test(hostname);
}

export function matchAll(html: string, re: RegExp): RegExpMatchArray[] {
  return Array.from(html.matchAll(re));
}

export function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return m ? (m[1] ?? m[2] ?? null) : null;
}

export function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseRobots(text: string): { blockedAiBots: string[]; allowedAiBots: string[]; blocksAll: boolean } {
  const blocked = new Set<string>();
  const allowed = new Set<string>();
  let blocksAll = false;
  let currentAgents: string[] = [];
  let sawRuleForCurrent = true;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [keyRaw, ...rest] = line.split(":");
    const key = keyRaw.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      if (sawRuleForCurrent) { currentAgents = []; sawRuleForCurrent = false; }
      currentAgents.push(value.toLowerCase());
    } else if (key === "disallow" || key === "allow") {
      sawRuleForCurrent = true;
      const isDisallowAll = key === "disallow" && (value === "/" || value === "/*");
      for (const agent of currentAgents) {
        const bot = AI_BOTS.find((b) => b.toLowerCase() === agent);
        if (agent === "*" && isDisallowAll) blocksAll = true;
        if (bot) {
          if (isDisallowAll) blocked.add(bot);
          else if (key === "allow" || value === "") allowed.add(bot);
        }
      }
    }
  }
  for (const b of blocked) allowed.delete(b);
  return { blockedAiBots: [...blocked], allowedAiBots: [...allowed], blocksAll };
}

export type HtmlSignals = {
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  ogTags: string[];
  hasTwitterCard: boolean;
  htmlLang: string | null;
  hasViewport: boolean;
  h1Count: number;
  headingOutline: string[];
  jsonLdTypes: string[];
  jsonLdErrors: number;
  hasMicrodata: boolean;
  wordCount: number;
  imageCount: number;
  imagesWithAlt: number;
  semanticTags: string[];
  robotsMetaNoindex: boolean;
};

export function extractHtmlSignals(html: string): HtmlSignals {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaTags = matchAll(html, /<meta\b[^>]*>/gi).map((m) => m[0]);
  const findMeta = (nameValue: string) => {
    const tag = metaTags.find((t) => (attr(t, "name") ?? attr(t, "property"))?.toLowerCase() === nameValue);
    return tag ? attr(tag, "content") : null;
  };
  const ogTags = metaTags
    .map((t) => attr(t, "property")?.toLowerCase())
    .filter((p): p is string => !!p && p.startsWith("og:"));
  const robotsMeta = findMeta("robots")?.toLowerCase() ?? "";

  const jsonLdTypes: string[] = [];
  let jsonLdErrors = 0;
  for (const m of matchAll(html, /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(m[1]);
      const nodes = Array.isArray(parsed) ? parsed : parsed["@graph"] ? parsed["@graph"] : [parsed];
      for (const node of nodes) {
        const t = node?.["@type"];
        if (typeof t === "string") jsonLdTypes.push(t);
        else if (Array.isArray(t)) jsonLdTypes.push(...t.filter((x: unknown) => typeof x === "string"));
      }
    } catch { jsonLdErrors++; }
  }

  const headings = matchAll(html, /<(h[1-3])[^>]*>([\s\S]*?)<\/\1>/gi)
    .map((m) => `${m[1].toUpperCase()}: ${stripTags(m[2]).slice(0, 80)}`)
    .slice(0, 25);
  const imgs = matchAll(html, /<img\b[^>]*>/gi).map((m) => m[0]);
  const semanticTags = ["main", "article", "nav", "header", "footer", "section"].filter((t) => new RegExp(`<${t}[\\s>]`, "i").test(html));
  const canonicalTag = matchAll(html, /<link\b[^>]*>/gi).map((m) => m[0]).find((t) => attr(t, "rel")?.toLowerCase() === "canonical");

  return {
    title: titleMatch ? stripTags(titleMatch[1]).slice(0, 200) || null : null,
    metaDescription: findMeta("description"),
    canonical: canonicalTag ? attr(canonicalTag, "href") : null,
    ogTags: [...new Set(ogTags)],
    hasTwitterCard: !!findMeta("twitter:card"),
    htmlLang: html.match(/<html[^>]*\blang\s*=\s*["']([^"']+)["']/i)?.[1] ?? null,
    hasViewport: !!findMeta("viewport"),
    h1Count: matchAll(html, /<h1[\s>]/gi).length,
    headingOutline: headings,
    jsonLdTypes: [...new Set(jsonLdTypes)],
    jsonLdErrors,
    hasMicrodata: /\bitemscope\b/i.test(html),
    wordCount: stripTags(html).split(" ").filter(Boolean).length,
    imageCount: imgs.length,
    imagesWithAlt: imgs.filter((t) => (attr(t, "alt") ?? "").trim().length > 0).length,
    semanticTags,
    robotsMetaNoindex: robotsMeta.includes("noindex"),
  };
}

export function isSitemapXml(text: string): boolean {
  return /<(urlset|sitemapindex)/i.test(text);
}

export function isValidLlmsTxt(text: string): boolean {
  return text.trim().length > 0 && !/<html/i.test(text);
}
