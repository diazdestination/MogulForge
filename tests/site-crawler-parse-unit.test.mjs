import test from "node:test";
import assert from "node:assert/strict";
import { extractInternalLinks, extractSitemapLocs } from "../lib/visibility-crawler-parse.ts";

// ---------------- extractSitemapLocs ----------------

test("extractSitemapLocs: pulls loc URLs from a urlset", () => {
  const xml = `<?xml version="1.0"?><urlset>
    <url><loc>https://example.com/</loc></url>
    <url><loc> https://example.com/services </loc></url>
    <url><loc>https://example.com/a?x=1&amp;y=2</loc></url>
  </urlset>`;
  assert.deepEqual(extractSitemapLocs(xml), [
    "https://example.com/",
    "https://example.com/services",
    "https://example.com/a?x=1&y=2",
  ]);
});

test("extractSitemapLocs: respects the limit", () => {
  const xml = Array.from({ length: 10 }, (_, i) => `<loc>https://e.com/p${i}</loc>`).join("");
  assert.equal(extractSitemapLocs(xml, 3).length, 3);
});

test("extractSitemapLocs: empty on non-sitemap content", () => {
  assert.deepEqual(extractSitemapLocs("<html><body>hi</body></html>"), []);
});

// ---------------- extractInternalLinks ----------------

const base = "https://example.com/blog/post";

test("extractInternalLinks: resolves relative links against the base", () => {
  const html = `<a href="/pricing">Pricing</a> <a href="about">About</a>`;
  assert.deepEqual(extractInternalLinks(html, base), [
    "https://example.com/pricing",
    "https://example.com/blog/about",
  ]);
});

test("extractInternalLinks: drops external, mailto, tel, javascript, and fragment-only links", () => {
  const html = `
    <a href="https://other.com/page">x</a>
    <a href="mailto:a@b.com">x</a>
    <a href="tel:+15551234567">x</a>
    <a href="javascript:void(0)">x</a>
    <a href="#section">x</a>
    <a href="/ok">x</a>`;
  assert.deepEqual(extractInternalLinks(html, base), ["https://example.com/ok"]);
});

test("extractInternalLinks: strips fragments and dedupes", () => {
  const html = `<a href="/a#top">x</a><a href="/a#bottom">x</a><a href="/a">x</a>`;
  assert.deepEqual(extractInternalLinks(html, base), ["https://example.com/a"]);
});

test("extractInternalLinks: skips asset files", () => {
  const html = `<a href="/logo.png">x</a><a href="/doc.pdf">x</a><a href="/style.css">x</a><a href="/page">x</a>`;
  assert.deepEqual(extractInternalLinks(html, base), ["https://example.com/page"]);
});

test("extractInternalLinks: same host different scheme/port is treated as external", () => {
  const html = `<a href="http://example.com/insecure">x</a><a href="https://example.com:8443/alt">x</a>`;
  assert.deepEqual(extractInternalLinks(html, base), []);
});

test("extractInternalLinks: respects the limit and handles bad base", () => {
  const html = Array.from({ length: 20 }, (_, i) => `<a href="/p${i}">x</a>`).join("");
  assert.equal(extractInternalLinks(html, base, 5).length, 5);
  assert.deepEqual(extractInternalLinks(html, "not a url"), []);
});

test("extractInternalLinks: decodes &amp; in hrefs", () => {
  const html = `<a href="/search?a=1&amp;b=2">x</a>`;
  assert.deepEqual(extractInternalLinks(html, base), ["https://example.com/search?a=1&b=2"]);
});
