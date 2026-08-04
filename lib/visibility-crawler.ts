import "server-only";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { extractHtmlSignals, isPrivateHostname, isPrivateIp, isSitemapXml, isValidLlmsTxt, parseRobots } from "./visibility-crawler-parse.ts";

const FETCH_TIMEOUT_MS = 12_000;
const MAX_BYTES = 1_500_000;
const MAX_REDIRECTS = 5;

export async function assertPublicHost(url: URL): Promise<string | null> {
  if (!/^https?:$/.test(url.protocol)) return "Only http and https websites can be scanned.";
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isPrivateHostname(hostname)) return "That address points to a private network and can't be scanned.";
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

export async function fetchWithLimits(url: string, accept = "text/html"): Promise<{ status: number; text: string; finalUrl: string } | null> {
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

export async function crawlSite(inputUrl: string): Promise<{ signals: CrawlSignals } | { error: string }> {
  const url = new URL(inputUrl);
  const hostError = await assertPublicHost(url);
  if (hostError) return { error: hostError };
  const page = await fetchWithLimits(url.href);
  if (!page) return { error: "We couldn't reach that website. Check the address and try again." };
  if (page.status >= 400) return { error: `The site responded with an error (HTTP ${page.status}). Try the exact address of your live homepage.` };
  const html = page.text;
  const origin = new URL(page.finalUrl).origin;
  const htmlSignals = extractHtmlSignals(html);

  const [robotsRes, sitemapRes, llmsRes] = await Promise.all([
    fetchWithLimits(`${origin}/robots.txt`, "text/plain"),
    fetchWithLimits(`${origin}/sitemap.xml`, "application/xml"),
    fetchWithLimits(`${origin}/llms.txt`, "text/plain"),
  ]);
  const robotsFound = !!robotsRes && robotsRes.status === 200;
  const robots = robotsFound ? parseRobots(robotsRes.text) : { blockedAiBots: [], allowedAiBots: [], blocksAll: false };

  return {
    signals: {
      ...htmlSignals,
      finalUrl: page.finalUrl,
      status: page.status,
      robotsTxt: { found: robotsFound, ...robots },
      sitemap: !!sitemapRes && sitemapRes.status === 200 && isSitemapXml(sitemapRes.text),
      llmsTxt: !!llmsRes && llmsRes.status === 200 && isValidLlmsTxt(llmsRes.text),
    },
  };
}
