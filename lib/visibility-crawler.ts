import "server-only";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const AI_BOTS = ["GPTBot", "ClaudeBot", "Claude-Web", "PerplexityBot", "Google-Extended", "CCBot", "anthropic-ai", "Bytespider"];
const FETCH_TIMEOUT_MS = 12_000;
const MAX_BYTES = 1_500_000;
const MAX_REDIRECTS = 5;

function isPrivateIp(address: string): boolean {
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

async function assertPublicHost(url: URL): Promise<string | null> {
  if (!/^https?:$/.test(url.protocol)) return "Only http and https websites can be scanned.";
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.(localhost|local|internal|home\.arpa))$/i.test(hostname)) return "That address points to a private network and can't be scanned.";
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) return "That address points to a private network and can't be scanned.";
    return null;
  }
  try {
    const addresses = await lookup(hostname, { all: true });
    if (addresses.length === 0) return "We couldn't reach that website. Check the address and try again.";
    if (addresses.some((a) => isPrivateIp(a.address))) return "That address points to a private network and can't be scanned.";
    return null;
  } catch {
    return "We couldn't reach that website. Check the address and try again.";
  }
}

export type CrawlSignals = {
  finalUrl: string;
  status: number;
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
  robotsTxt: { found: boolean; blockedAiBots: string[]; allowedAiBots: string[]; blocksAll: boolean };
  sitemap: boolean;
  llmsTxt: boolean;
  robotsMetaNoindex: boolean;
};

async function fetchWithLimits(url: string, accept = "text/html"): Promise<{ status: number; text: string; finalUrl: string } | null> {
  let current = new URL(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (await assertPublicHost(current)) return null;
      res = await fetch(current.href, {
        signal: controller.signal,
        redirect: "manual",
        headers: { "User-Agent": "MogulForgeVisibilityBot/1.0 (+https://mogulforge.com)", Accept: accept },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location || hop === MAX_REDIRECTS) return null;
        current = new URL(location, current);
        continue;
      }
      break;
    }
    if (!res) return null;
    const finalUrl = current.href;
    const reader = res.body?.getReader();
    if (!reader) return { status: res.status, text: "", finalUrl };
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (received < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
    }
    reader.cancel().catch(() => {});
    const text = new TextDecoder("utf-8", { fatal: false }).decode(concat(chunks));
    return { status: res.status, text, finalUrl };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out;
}

function matchAll(html: string, re: RegExp): RegExpMatchArray[] {
  return Array.from(html.matchAll(re));
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return m ? (m[1] ?? m[2] ?? null) : null;
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseRobots(text: string): { blockedAiBots: string[]; allowedAiBots: string[]; blocksAll: boolean } {
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

export async function crawlSite(inputUrl: string): Promise<{ signals: CrawlSignals } | { error: string }> {
  const url = new URL(inputUrl);
  const hostError = await assertPublicHost(url);
  if (hostError) return { error: hostError };
  const page = await fetchWithLimits(url.href);
  if (!page) return { error: "We couldn't reach that website. Check the address and try again." };
  if (page.status >= 400) return { error: `The site responded with an error (HTTP ${page.status}). Try the exact address of your live homepage.` };
  const html = page.text;
  const origin = new URL(page.finalUrl).origin;

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

  const [robotsRes, sitemapRes, llmsRes] = await Promise.all([
    fetchWithLimits(`${origin}/robots.txt`, "text/plain"),
    fetchWithLimits(`${origin}/sitemap.xml`, "application/xml"),
    fetchWithLimits(`${origin}/llms.txt`, "text/plain"),
  ]);
  const robotsFound = !!robotsRes && robotsRes.status === 200;
  const robots = robotsFound ? parseRobots(robotsRes.text) : { blockedAiBots: [], allowedAiBots: [], blocksAll: false };

  return {
    signals: {
      finalUrl: page.finalUrl,
      status: page.status,
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
      robotsTxt: { found: robotsFound, ...robots },
      sitemap: !!sitemapRes && sitemapRes.status === 200 && /<(urlset|sitemapindex)/i.test(sitemapRes.text),
      llmsTxt: !!llmsRes && llmsRes.status === 200 && llmsRes.text.trim().length > 0 && !/<html/i.test(llmsRes.text),
      robotsMetaNoindex: robotsMeta.includes("noindex"),
    },
  };
}
