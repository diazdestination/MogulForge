import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_EMBED_THEME,
  mergeEmbedTheme,
  normalizeEmbedTheme,
  themeOverridesFromParams,
} from "../lib/embed/theme-core.ts";

test("normalizeEmbedTheme falls back to defaults for garbage input", () => {
  assert.deepEqual(normalizeEmbedTheme(null), DEFAULT_EMBED_THEME);
  assert.deepEqual(normalizeEmbedTheme("nope"), DEFAULT_EMBED_THEME);
  assert.deepEqual(normalizeEmbedTheme([1, 2]), DEFAULT_EMBED_THEME);
  assert.deepEqual(
    normalizeEmbedTheme({ mode: "neon", accentColor: "red", backgroundColor: "url(x)", radius: "huge", logoUrl: "javascript:alert(1)" }),
    DEFAULT_EMBED_THEME,
  );
});

test("normalizeEmbedTheme accepts valid values and trims", () => {
  const theme = normalizeEmbedTheme({ mode: "light", accentColor: " #0E7490 ", backgroundColor: "#fff", radius: "md", logoUrl: "https://x.com/logo.svg" });
  assert.deepEqual(theme, { mode: "light", accentColor: "#0E7490", backgroundColor: "#fff", radius: "md", logoUrl: "https://x.com/logo.svg" });
});

test("normalizeEmbedTheme rejects CSS-injection attempts in colors and logos", () => {
  const theme = normalizeEmbedTheme({
    accentColor: "#fff; background-image: url(evil)",
    backgroundColor: "#123456\u0022><script>",
    logoUrl: 'https://x.com/a.png" onerror="alert(1)',
  });
  assert.equal(theme.accentColor, null);
  assert.equal(theme.backgroundColor, null);
  assert.equal(theme.logoUrl, null);
});

test("normalizeEmbedTheme: empty string / null clears a value, undefined keeps base", () => {
  const base = { ...DEFAULT_EMBED_THEME, accentColor: "#abc123", logoUrl: "https://x.com/l.png" };
  const cleared = normalizeEmbedTheme({ accentColor: "", logoUrl: null }, base);
  assert.equal(cleared.accentColor, null);
  assert.equal(cleared.logoUrl, null);
  const kept = normalizeEmbedTheme({}, base);
  assert.equal(kept.accentColor, "#abc123");
  assert.equal(kept.logoUrl, "https://x.com/l.png");
});

test("themeOverridesFromParams only picks up valid query params", () => {
  const params = new Map([
    ["t_mode", "light"],
    ["t_accent", "#123abc"],
    ["t_bg", "not-a-color"],
    ["t_radius", "xl"],
    ["t_logo", "http://insecure.com/logo.png"],
  ]);
  const overrides = themeOverridesFromParams((k) => params.get(k) ?? null);
  assert.deepEqual(overrides, { mode: "light", accentColor: "#123abc", radius: "xl" });
});

test("mergeEmbedTheme: overrides win, missing keys inherit org defaults", () => {
  const base = normalizeEmbedTheme({ mode: "dark", accentColor: "#111111", radius: "lg", logoUrl: "https://org.com/l.png" });
  const merged = mergeEmbedTheme(base, { mode: "light", accentColor: "#222222" });
  assert.equal(merged.mode, "light");
  assert.equal(merged.accentColor, "#222222");
  assert.equal(merged.radius, "lg");
  assert.equal(merged.logoUrl, "https://org.com/l.png");
});
