import test from "node:test";
import assert from "node:assert/strict";
import { scoreCategories, overallScore, fallbackReport } from "../lib/visibility-score.ts";

/** Baseline: a well-optimized "perfect" site. */
function perfectSignals(overrides = {}) {
  return {
    finalUrl: "https://example.com/",
    status: 200,
    title: "Example — Great Roofing",
    metaDescription: "We do great roofing.",
    canonical: "https://example.com/",
    ogTags: ["og:title", "og:description", "og:image"],
    hasTwitterCard: true,
    htmlLang: "en",
    hasViewport: true,
    h1Count: 1,
    headingOutline: ["H1: Home", "H2: Services", "H2: About", "H3: Team"],
    jsonLdTypes: ["Organization", "WebSite"],
    jsonLdErrors: 0,
    hasMicrodata: true,
    wordCount: 800,
    imageCount: 10,
    imagesWithAlt: 9,
    semanticTags: ["main", "nav", "footer"],
    robotsTxt: { found: true, blockedAiBots: [], allowedAiBots: ["GPTBot"], blocksAll: false },
    sitemap: true,
    llmsTxt: true,
    robotsMetaNoindex: false,
    ...overrides,
  };
}

function byName(categories, name) {
  const c = categories.find((x) => x.name === name);
  assert.ok(c, `category ${name} present`);
  return c;
}

test("scoreCategories returns the four rubric categories in order", () => {
  const cats = scoreCategories(perfectSignals());
  assert.deepEqual(
    cats.map((c) => c.name),
    ["Schema & structured data", "AI crawlability", "Metadata", "Content structure"],
  );
  for (const c of cats) {
    assert.ok(Number.isInteger(c.score) && c.score >= 0 && c.score <= 100, `${c.name} score in range`);
    assert.ok(c.findings.length > 0, `${c.name} has findings`);
  }
});

test("a perfect site scores 100 in every category and overall", () => {
  const cats = scoreCategories(perfectSignals());
  for (const c of cats) assert.equal(c.score, 100, c.name);
  assert.equal(overallScore(cats), 100);
});

test("blocked-robots site: crawlability collapses to 0 with clear findings", () => {
  const cats = scoreCategories(perfectSignals({
    robotsTxt: { found: true, blockedAiBots: ["GPTBot", "ClaudeBot"], allowedAiBots: [], blocksAll: true },
    robotsMetaNoindex: true,
  }));
  const crawl = byName(cats, "AI crawlability");
  // 25 base - 25 blocksAll + 0 (AI bots blocked) + 25 sitemap + 20 llms - 40 noindex = 5
  assert.equal(crawl.score, 5);
  assert.ok(crawl.findings.some((f) => /disallows all crawlers/i.test(f)));
  assert.ok(crawl.findings.some((f) => /GPTBot, ClaudeBot/.test(f)));
  assert.ok(crawl.findings.some((f) => /noindex/i.test(f)));
  // other categories unaffected
  assert.equal(byName(cats, "Metadata").score, 100);
  assert.equal(byName(cats, "Schema & structured data").score, 100);
});

test("missing robots/sitemap/llms bottoms out crawlability at clamp(0)", () => {
  const cats = scoreCategories(perfectSignals({
    robotsTxt: { found: false, blockedAiBots: [], allowedAiBots: [], blocksAll: false },
    sitemap: false,
    llmsTxt: false,
    robotsMetaNoindex: true,
  }));
  // 25 - 10 no robots + 30 no AI blocked - 40 noindex = 5
  assert.equal(byName(cats, "AI crawlability").score, 5);
});

test("thin-content site: content structure scores 0", () => {
  const cats = scoreCategories(perfectSignals({
    h1Count: 0,
    headingOutline: [],
    wordCount: 40,
    semanticTags: [],
    imageCount: 4,
    imagesWithAlt: 1,
  }));
  const content = byName(cats, "Content structure");
  assert.equal(content.score, 0);
  assert.ok(content.findings.some((f) => /No H1/i.test(f)));
  assert.ok(content.findings.some((f) => /Thin heading structure/i.test(f)));
  assert.ok(content.findings.some((f) => /~40 words/.test(f)));
  assert.ok(content.findings.some((f) => /1\/4 images/.test(f)));
});

test("content edge cases: multiple H1s partial credit, no images gets alt credit", () => {
  const multi = scoreCategories(perfectSignals({ h1Count: 3 }));
  // 10 (multi-H1) + 20 + 20 + 20 + 15 = 85
  assert.equal(byName(multi, "Content structure").score, 85);

  const noImages = scoreCategories(perfectSignals({ imageCount: 0, imagesWithAlt: 0 }));
  // 25 + 20 + 20 + 20 + 10 (no images) = 95
  assert.equal(byName(noImages, "Content structure").score, 95);
});

test("schema: no JSON-LD scores near zero; parse errors penalize", () => {
  const none = scoreCategories(perfectSignals({ jsonLdTypes: [], hasMicrodata: false }));
  assert.equal(byName(none, "Schema & structured data").score, 0);

  const broken = scoreCategories(perfectSignals({ jsonLdTypes: ["Article"], jsonLdErrors: 2, hasMicrodata: false }));
  // 60 (has JSON-LD) + 0 (no entity type) - 15 errors = 45
  const cat = byName(broken, "Schema & structured data");
  assert.equal(cat.score, 45);
  assert.ok(cat.findings.some((f) => /2 JSON-LD block\(s\) failed to parse/.test(f)));
});

test("metadata: missing everything scores 0 with missing findings", () => {
  const cats = scoreCategories(perfectSignals({
    title: null, metaDescription: null, canonical: null, ogTags: [], hasTwitterCard: false, htmlLang: null,
  }));
  const meta = byName(cats, "Metadata");
  assert.equal(meta.score, 0);
  assert.ok(meta.findings.some((f) => /Missing <title>/i.test(f)));
  assert.ok(meta.findings.some((f) => /Missing meta description/i.test(f)));
});

test("overallScore applies 30/30/20/20 weights and rounds", () => {
  const cats = [
    { name: "Schema & structured data", score: 100, findings: [] },
    { name: "AI crawlability", score: 0, findings: [] },
    { name: "Metadata", score: 50, findings: [] },
    { name: "Content structure", score: 50, findings: [] },
  ];
  assert.equal(overallScore(cats), 50); // 30 + 0 + 10 + 10
  assert.equal(overallScore(cats.map((c) => ({ ...c, score: 33 }))), 33);
  // unknown categories default to 0.25 weight
  assert.equal(overallScore([{ name: "Mystery", score: 80, findings: [] }]), 20);
  // clamped to 0..100
  assert.equal(overallScore(cats.map((c) => ({ ...c, score: 100 }))), 100);
});

test("fallbackReport recommends fixes for the three weakest categories", () => {
  const signals = perfectSignals({
    jsonLdTypes: [], hasMicrodata: false, // schema -> 0
    title: null, metaDescription: null, canonical: null, ogTags: [], hasTwitterCard: false, htmlLang: null, // meta -> 0
  });
  const cats = scoreCategories(signals);
  const report = fallbackReport(signals, cats);

  assert.equal(report.score, overallScore(cats));
  assert.equal(report.categories, cats);
  assert.equal(report.recommendations.length, 3);
  // weakest-first ordering: schema (0) and metadata (0) come before the 100-score categories
  const titles = report.recommendations.map((r) => r.title);
  assert.ok(titles.includes("Strengthen schema & structured data"));
  assert.ok(titles.includes("Strengthen metadata"));
  const schemaRec = report.recommendations.find((r) => r.title.includes("schema"));
  assert.ok(/JSON-LD Organization\/LocalBusiness/.test(schemaRec.fix));
  assert.ok(/no |missing/i.test(schemaRec.why));
  assert.ok(report.summary.includes(String(report.score)));
  assert.ok(report.summary.includes(signals.finalUrl));
});

test("fallbackReport why falls back to generic text when no negative finding exists", () => {
  const signals = perfectSignals();
  const cats = scoreCategories(signals).map((c) => ({ ...c, findings: ["All good."] }));
  const report = fallbackReport(signals, cats);
  for (const rec of report.recommendations) {
    assert.ok(/weakest part of your AI visibility profile/.test(rec.why));
  }
});
