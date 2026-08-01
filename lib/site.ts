/**
 * Canonical site identity used by metadata, sitemap, robots, and OG images.
 * NEXT_PUBLIC_SITE_URL overrides the published URL once a custom domain exists.
 */
const FALLBACK_SITE_URL = "https://mogulforge.replit.app";

/** Accepts "https://x.com", "x.com", trailing slashes; falls back safely on garbage so builds never crash. */
function normalizeSiteUrl(raw: string | undefined): string {
  if (!raw?.trim()) return FALLBACK_SITE_URL;
  const candidate = /^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
  try {
    return new URL(candidate).origin;
  } catch {
    console.error(`Invalid NEXT_PUBLIC_SITE_URL ${JSON.stringify(raw)} — using ${FALLBACK_SITE_URL}`);
    return FALLBACK_SITE_URL;
  }
}

export const SITE_URL = normalizeSiteUrl(process.env.NEXT_PUBLIC_SITE_URL);
export const SITE_NAME = "MogulForge";
export const SITE_TAGLINE = "Recover the Revenue You're Already Losing";
export const SITE_DESCRIPTION =
  "AI Revenue Rescue™ finds the hidden leaks costing your business leads and sales—then installs the systems that recover them.";

export const BRAND = {
  ink: "#090d0c",
  cream: "#f3f0e8",
  lime: "#c9f75d",
  moss: "#23332b",
  rust: "#e36c3d",
} as const;
