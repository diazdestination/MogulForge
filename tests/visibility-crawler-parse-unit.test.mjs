import test from "node:test";
import assert from "node:assert/strict";
import {
  parseRobots,
  extractHtmlSignals,
  isPrivateIp,
  isPrivateHostname,
  isSitemapXml,
  isValidLlmsTxt,
} from "../lib/visibility-crawler-parse.ts";

// ---------------- parseRobots ----------------

test("parseRobots: wildcard disallow-all sets blocksAll", () => {
  const r = parseRobots("User-agent: *\nDisallow: /");
  assert.equal(r.blocksAll, true);
  assert.deepEqual(r.blockedAiBots, []);
  assert.deepEqual(r.allowedAiBots, []);
});

test("parseRobots: 'Disallow: /*' also counts as blocking all", () => {
  const r = parseRobots("User-agent: *\nDisallow: /*");
  assert.equal(r.blocksAll, true);
});

test("parseRobots: partial disallow does not set blocksAll", () => {
  const r = parseRobots("User-agent: *\nDisallow: /admin");
  assert.equal(r.blocksAll, false);
});

test("parseRobots: AI bot fully disallowed is blocked", () => {
  const r = parseRobots("User-agent: GPTBot\nDisallow: /");
  assert.deepEqual(r.blockedAiBots, ["GPTBot"]);
  assert.deepEqual(r.allowedAiBots, []);
  assert.equal(r.blocksAll, false);
});

test("parseRobots: AI bot with empty disallow or Allow is allowed", () => {
  const empty = parseRobots("User-agent: ClaudeBot\nDisallow:");
  assert.deepEqual(empty.allowedAiBots, ["ClaudeBot"]);
  const allow = parseRobots("User-agent: PerplexityBot\nAllow: /");
  assert.deepEqual(allow.allowedAiBots, ["PerplexityBot"]);
});

test("parseRobots: bot names are matched case-insensitively", () => {
  const r = parseRobots("User-Agent: gptbot\nDisallow: /");
  assert.deepEqual(r.blockedAiBots, ["GPTBot"]);
});

test("parseRobots: grouped user-agents share the following rules", () => {
  const r = parseRobots("User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /");
  assert.deepEqual(new Set(r.blockedAiBots), new Set(["GPTBot", "ClaudeBot"]));
});

test("parseRobots: a new user-agent after rules starts a new group", () => {
  const r = parseRobots(
    "User-agent: GPTBot\nDisallow: /\nUser-agent: ClaudeBot\nAllow: /",
  );
  assert.deepEqual(r.blockedAiBots, ["GPTBot"]);
  assert.deepEqual(r.allowedAiBots, ["ClaudeBot"]);
});

test("parseRobots: blocked wins over allowed for the same bot", () => {
  const r = parseRobots(
    "User-agent: GPTBot\nAllow: /public\nUser-agent: GPTBot\nDisallow: /",
  );
  assert.deepEqual(r.blockedAiBots, ["GPTBot"]);
  assert.deepEqual(r.allowedAiBots, []);
});

test("parseRobots: comments, blank lines, and CRLF are handled", () => {
  const r = parseRobots("# comment\r\n\r\nUser-agent: * # inline\r\nDisallow: / # all\r\n");
  assert.equal(r.blocksAll, true);
});

test("parseRobots: values containing colons (e.g. sitemap URLs) don't break parsing", () => {
  const r = parseRobots("Sitemap: https://example.com/sitemap.xml\nUser-agent: *\nDisallow: /");
  assert.equal(r.blocksAll, true);
});

test("parseRobots: empty input yields no blocks", () => {
  assert.deepEqual(parseRobots(""), { blockedAiBots: [], allowedAiBots: [], blocksAll: false });
});

// ---------------- JSON-LD extraction ----------------

const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

test("JSON-LD: simple @type string is extracted", () => {
  const s = extractHtmlSignals(`<html>${ld({ "@type": "Organization" })}</html>`);
  assert.deepEqual(s.jsonLdTypes, ["Organization"]);
  assert.equal(s.jsonLdErrors, 0);
});

test("JSON-LD: @graph nodes and arrays of types are flattened", () => {
  const s = extractHtmlSignals(
    `<html>${ld({ "@graph": [{ "@type": "WebSite" }, { "@type": ["LocalBusiness", "Organization"] }] })}</html>`,
  );
  assert.deepEqual(new Set(s.jsonLdTypes), new Set(["WebSite", "LocalBusiness", "Organization"]));
});

test("JSON-LD: top-level array of nodes is handled", () => {
  const s = extractHtmlSignals(`<html>${ld([{ "@type": "Article" }, { "@type": "FAQPage" }])}</html>`);
  assert.deepEqual(new Set(s.jsonLdTypes), new Set(["Article", "FAQPage"]));
});

test("JSON-LD: malformed JSON counts as an error without throwing", () => {
  const s = extractHtmlSignals(
    `<html><script type="application/ld+json">{not json</script>${ld({ "@type": "WebSite" })}</html>`,
  );
  assert.equal(s.jsonLdErrors, 1);
  assert.deepEqual(s.jsonLdTypes, ["WebSite"]);
});

test("JSON-LD: duplicate types are deduped; non-string types ignored", () => {
  const s = extractHtmlSignals(
    `<html>${ld({ "@type": "WebSite" })}${ld({ "@type": "WebSite" })}${ld({ "@type": 42 })}</html>`,
  );
  assert.deepEqual(s.jsonLdTypes, ["WebSite"]);
  assert.equal(s.jsonLdErrors, 0);
});

// ---------------- meta / OG / canonical / misc HTML ----------------

test("extractHtmlSignals: title, meta description, canonical, lang, viewport", () => {
  const s = extractHtmlSignals(`
    <html lang="en-US"><head>
      <title> My <b>Site</b> </title>
      <meta name="description" content="Hello world">
      <meta name="viewport" content="width=device-width">
      <link rel="canonical" href="https://example.com/">
    </head><body></body></html>`);
  assert.equal(s.title, "My Site");
  assert.equal(s.metaDescription, "Hello world");
  assert.equal(s.canonical, "https://example.com/");
  assert.equal(s.htmlLang, "en-US");
  assert.equal(s.hasViewport, true);
});

test("extractHtmlSignals: OG tags deduped, twitter card, robots noindex", () => {
  const s = extractHtmlSignals(`
    <meta property="og:title" content="A">
    <meta property="OG:TITLE" content="dup">
    <meta property="og:image" content="i.png">
    <meta name="twitter:card" content="summary">
    <meta name="robots" content="NOINDEX, nofollow">`);
  assert.deepEqual(new Set(s.ogTags), new Set(["og:title", "og:image"]));
  assert.equal(s.hasTwitterCard, true);
  assert.equal(s.robotsMetaNoindex, true);
});

test("extractHtmlSignals: missing everything yields nulls and empties", () => {
  const s = extractHtmlSignals("<html><body>hi</body></html>");
  assert.equal(s.title, null);
  assert.equal(s.metaDescription, null);
  assert.equal(s.canonical, null);
  assert.deepEqual(s.ogTags, []);
  assert.equal(s.hasTwitterCard, false);
  assert.equal(s.htmlLang, null);
  assert.equal(s.robotsMetaNoindex, false);
});

test("extractHtmlSignals: single-quoted attributes are supported", () => {
  const s = extractHtmlSignals(`<meta name='description' content='single quotes'>`);
  assert.equal(s.metaDescription, "single quotes");
});

test("extractHtmlSignals: headings, h1 count, word count, images, semantic tags", () => {
  const s = extractHtmlSignals(`
    <html><body>
      <main><h1>Big <em>Title</em></h1>
      <h2>Section</h2><h3>Sub</h3>
      <img src="a.png" alt="A photo"><img src="b.png" alt=" "><img src="c.png">
      <nav>menu</nav><footer>foot</footer>
      <script>var junk = "should not count";</script>
      <style>.x{}</style>
      one two three four</main>
    </body></html>`);
  assert.equal(s.h1Count, 1);
  assert.deepEqual(s.headingOutline, ["H1: Big Title", "H2: Section", "H3: Sub"]);
  assert.equal(s.imageCount, 3);
  assert.equal(s.imagesWithAlt, 1); // blank alt doesn't count
  assert.deepEqual(new Set(s.semanticTags), new Set(["main", "nav", "footer"]));
  assert.ok(!/junk|should/.test(String(s.wordCount)));
  // words: Big Title Section Sub menu foot one two three four = 10
  assert.equal(s.wordCount, 10);
});

test("extractHtmlSignals: heading outline truncates long text and caps at 25", () => {
  const long = "x".repeat(200);
  const many = Array.from({ length: 30 }, (_, i) => `<h2>${long}${i}</h2>`).join("");
  const s = extractHtmlSignals(many);
  assert.equal(s.headingOutline.length, 25);
  assert.equal(s.headingOutline[0], `H2: ${"x".repeat(80)}`);
});

test("extractHtmlSignals: microdata flag", () => {
  assert.equal(extractHtmlSignals(`<div itemscope itemtype="https://schema.org/Person"></div>`).hasMicrodata, true);
  assert.equal(extractHtmlSignals(`<div></div>`).hasMicrodata, false);
});

// ---------------- private-IP / hostname guard ----------------

test("isPrivateIp: private IPv4 ranges are rejected", () => {
  for (const ip of [
    "0.0.0.0", "10.1.2.3", "127.0.0.1", "100.64.0.1", "100.127.255.255",
    "169.254.1.1", "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.0.2.1",
    "198.18.0.1", "198.19.5.5", "224.0.0.1", "255.255.255.255",
  ]) assert.equal(isPrivateIp(ip), true, ip);
});

test("isPrivateIp: public IPv4 addresses are allowed", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "100.63.0.1", "100.128.0.1", "172.15.0.1", "172.32.0.1", "198.17.0.1", "223.255.255.255"])
    assert.equal(isPrivateIp(ip), false, ip);
});

test("isPrivateIp: IPv6 loopback, link-local, unique-local, multicast are private", () => {
  for (const ip of ["::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1"])
    assert.equal(isPrivateIp(ip), true, ip);
});

test("isPrivateIp: IPv4-mapped IPv6 defers to the IPv4 check", () => {
  assert.equal(isPrivateIp("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateIp("::ffff:8.8.8.8"), false);
});

test("isPrivateIp: public IPv6 allowed; non-IP strings treated as private", () => {
  assert.equal(isPrivateIp("2606:4700::1111"), false);
  assert.equal(isPrivateIp("not-an-ip"), true);
});

test("isPrivateHostname: localhost and internal suffixes are private", () => {
  for (const h of ["localhost", "LOCALHOST", "foo.localhost", "printer.local", "db.internal", "nas.home.arpa"])
    assert.equal(isPrivateHostname(h), true, h);
  for (const h of ["example.com", "local.example.com", "internal-tools.example.com"])
    assert.equal(isPrivateHostname(h), false, h);
});

// ---------------- sitemap / llms.txt validators ----------------

test("isSitemapXml accepts urlset and sitemapindex, rejects HTML", () => {
  assert.equal(isSitemapXml(`<?xml version="1.0"?><urlset></urlset>`), true);
  assert.equal(isSitemapXml(`<sitemapindex>`), true);
  assert.equal(isSitemapXml(`<html><body>404</body></html>`), false);
});

test("isValidLlmsTxt requires non-empty non-HTML content", () => {
  assert.equal(isValidLlmsTxt("# My site\nStuff"), true);
  assert.equal(isValidLlmsTxt("   \n  "), false);
  assert.equal(isValidLlmsTxt("<html><body>SPA fallback</body></html>"), false);
});
