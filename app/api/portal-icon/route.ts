import { NextResponse, type NextRequest } from "next/server";
import sharp from "sharp";
import { getPortalHostContext } from "@/lib/portal-host";
import { checkLogoUrl } from "@/lib/logo-url-core";
import { fetchPublicImage, UnsafeImageUrlError } from "@/lib/safe-image-fetch";

/**
 * Crisp square favicon for custom-domain portals.
 *
 * Org logos are arbitrary uploads — huge PNGs, wide wordmarks — and browsers
 * scale whatever is referenced as the icon, which looks blurry or squished at
 * 16–32px. This route fetches the org's logo (resolved from the request's
 * Host header, same as the rest of the portal) and serves a small square PNG:
 * the logo resized to fit inside the square on a transparent background.
 *
 * The logo URL is tenant-controlled, so the server-side fetch is SSRF-guarded
 * (lib/safe-image-fetch.ts): public hostnames only, DNS resolved and vetted
 * here, connection pinned to the vetted IP, redirects refused. Relative logo
 * paths are fetched from this app's own origin (first-party asset surface).
 *
 * Falls back gracefully: processing failures redirect the browser to the raw
 * logo URL (a client-side fetch, no SSRF surface) so the tab still shows
 * *something*; unsafe URLs get 404 rather than any fetch at all.
 *
 * Server-side cache: generated PNGs are stored in memory keyed by
 * `orgId:logoUrl:size`. The layout's `v=` query param already changes
 * whenever the org's logo URL changes, so the browser will hit the server with
 * a new URL — which naturally misses the cache and builds a fresh entry.
 * The cache is capped at MAX_CACHE_ENTRIES to bound memory use.
 */

const ALLOWED_SIZES = new Set([32, 64, 180]);
const FETCH_TIMEOUT_MS = 5000;

/** Max number of distinct (org × logo × size) entries to keep in memory. */
const MAX_CACHE_ENTRIES = 500;

/**
 * Module-level cache — persists across requests in the same process/instance.
 * Key: `${orgId}:${logoUrl}:${size}`  Value: PNG buffer
 */
const iconCache = new Map<string, Buffer>();

export async function GET(request: NextRequest) {
  const context = await getPortalHostContext();
  if (context.kind !== "portal") return new NextResponse("Not found", { status: 404 });

  const logoUrl = context.branding.logoUrl;
  if (!logoUrl) return new NextResponse("Not found", { status: 404 });

  const verdict = checkLogoUrl(logoUrl);
  if (!verdict.ok) return new NextResponse("Not found", { status: 404 });

  const sizeParam = Number(request.nextUrl.searchParams.get("size") ?? "64");
  const size = ALLOWED_SIZES.has(sizeParam) ? sizeParam : 64;

  const cacheKey = `${context.org.id}:${logoUrl}:${size}`;
  const cached = iconCache.get(cacheKey);
  if (cached) {
    return new NextResponse(new Uint8Array(cached), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=86400",
        "X-Robots-Tag": "noindex",
        "X-Icon-Cache": "hit",
      },
    });
  }

  try {
    const input =
      verdict.kind === "relative"
        ? await fetchOwnAsset(new URL(logoUrl, request.nextUrl.origin))
        : await fetchPublicImage(logoUrl, FETCH_TIMEOUT_MS);

    const png = await sharp(input, { limitInputPixels: 64_000_000 })
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    // Evict everything when the cap is reached to bound memory use.
    // The next cold request per org will rebuild its entry.
    if (iconCache.size >= MAX_CACHE_ENTRIES) iconCache.clear();
    iconCache.set(cacheKey, png);

    return new NextResponse(new Uint8Array(png), {
      headers: {
        "Content-Type": "image/png",
        // Icons change only when the org changes its logo; a day of caching
        // is fine and the metadata URL carries a version hash for busting.
        "Cache-Control": "public, max-age=86400",
        "X-Robots-Tag": "noindex",
      },
    });
  } catch (error) {
    if (error instanceof UnsafeImageUrlError) return new NextResponse("Not found", { status: 404 });
    // Graceful fallback: let the browser use the raw (validated) logo URL
    // rather than no icon — that fetch happens client-side.
    return NextResponse.redirect(new URL(logoUrl, request.nextUrl.origin), 302);
  }
}

/** Fetches a same-app relative asset — only reaches this app's own public routes. */
async function fetchOwnAsset(url: URL): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`logo fetch failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
