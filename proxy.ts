import { NextResponse, type NextRequest } from "next/server";
import { verifyEmbedToken } from "./lib/embed/tokens";

/**
 * Origin + CSP enforcement for embeddable pages. /embed/* responses get a
 * frame-ancestors policy derived from the (signed) embed token's origin claim:
 * a valid token allows exactly its approved origin, anything else gets 'none'.
 */
export default function proxy(request: NextRequest) {
  const response = NextResponse.next();
  const { pathname, searchParams } = request.nextUrl;
  if (pathname.startsWith("/embed") && !pathname.startsWith("/embed/v1")) {
    const token = searchParams.get("token") ?? "";
    const check = token ? verifyEmbedToken(token) : null;
    const ancestors = check?.valid ? `'self' ${check.claims.origin}` : "'none'";
    response.headers.set("Content-Security-Policy", `frame-ancestors ${ancestors}`);
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  return response;
}

export const config = { matcher: ["/embed/:path*"] };
