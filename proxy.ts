import { NextResponse, type NextRequest } from "next/server";
import { verifyEmbedToken } from "./lib/embed/tokens";
import { isPlatformHost, normalizeHostHeader, platformHostsFromEnv } from "./lib/custom-domain-core";

/**
 * 1. Origin + CSP enforcement for embeddable pages. /embed/* responses get a
 *    frame-ancestors policy derived from the (signed) embed token's origin
 *    claim: a valid token allows exactly its approved origin, else 'none'.
 * 2. Custom-domain portal routing: requests for "/" arriving on a non-platform
 *    host are rewritten to /portal, which resolves the host against active
 *    custom_domains (DB lookup lives there, not here) and either serves the
 *    owning org's branded portal or an honest "not connected" page.
 */
/** Paths that are allowed to serve on a custom-domain (portal) host. */
const PORTAL_PATH_PREFIXES = ["/login", "/dashboard", "/account", "/portal", "/invite", "/embed", "/api", "/opengraph-image"];

function isPortalPath(pathname: string): boolean {
  return PORTAL_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export default function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;

  if (!pathname.startsWith("/embed")) {
    const host = normalizeHostHeader(request.headers.get("x-forwarded-host") ?? request.headers.get("host"));
    if (host && !isPlatformHost(host, platformHostsFromEnv(process.env))) {
      // Custom-domain hosts never serve MogulForge marketing routes:
      // "/" is rewritten to the portal resolver, everything outside the
      // portal surface redirects there.
      if (pathname === "/") return NextResponse.rewrite(new URL("/portal", request.url));
      if (!isPortalPath(pathname)) return NextResponse.redirect(new URL("/", request.url));
    }
    if (pathname === "/") return NextResponse.next();
  }

  const response = NextResponse.next();
  if (pathname.startsWith("/embed") && !pathname.startsWith("/embed/v1")) {
    const token = searchParams.get("token") ?? "";
    const check = token ? verifyEmbedToken(token) : null;
    const ancestors = check?.valid ? `'self' ${check.claims.origin}` : "'none'";
    response.headers.set("Content-Security-Policy", `frame-ancestors ${ancestors}`);
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  return response;
}

// Match embeds (CSP), plus every page path (custom-domain routing). Static
// assets (_next, files with extensions) and API routes are excluded from the
// page matcher — APIs stay reachable on any host.
export const config = { matcher: ["/embed/:path*", "/((?!_next/|api/|embed/|.*\\..*).*)"] };
