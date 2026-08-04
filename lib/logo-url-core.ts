/**
 * Logo URL validation — pure module (unit-testable).
 *
 * Org logos are rendered in browsers AND fetched server-side (the portal
 * favicon route resizes them), so every path that stores a logo URL must
 * enforce the same policy: a same-app relative path, or an absolute http(s)
 * URL pointing at a public hostname. IP literals, localhost, single-label
 * hosts, and non-http schemes are rejected — they are never legitimate logo
 * hosts and are exactly the SSRF shapes an attacker would store.
 *
 * Hostname checks alone do not stop DNS rebinding; the server-side fetcher
 * (lib/safe-image-fetch.ts) additionally resolves DNS itself, rejects
 * private addresses, and pins the connection to the vetted IP.
 */

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

export type LogoUrlCheck = { ok: true; kind: "relative" | "absolute" } | { ok: false; reason: string };

export function checkLogoUrl(value: string): LogoUrlCheck {
  const url = value.trim();
  if (!url) return { ok: false, reason: "Logo URL must not be empty." };
  if (url.length > 2048) return { ok: false, reason: "Logo URL is too long." };

  // Same-app relative path ("/uploads/logo.png") — served by this app only.
  if (url.startsWith("/") && !url.startsWith("//")) return { ok: true, kind: "relative" };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "Logo URL must be a relative path or an absolute http(s) URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "Logo URL must use http or https." };
  }
  if (parsed.username || parsed.password) return { ok: false, reason: "Logo URL must not embed credentials." };

  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, reason: "Logo URL must include a hostname." };
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, reason: "Logo URL must point at a public host." };
  }
  if (IPV4_LITERAL.test(host) || host.includes(":") || (host.startsWith("[") && host.endsWith("]"))) {
    return { ok: false, reason: "Logo URL must use a hostname, not an IP address." };
  }
  if (!host.includes(".")) return { ok: false, reason: "Logo URL must use a fully-qualified hostname." };
  return { ok: true, kind: "absolute" };
}

/** Address-range guard shared with the pinned fetcher. Accepts IPv4 or IPv6 text. */
export function isPrivateAddress(address: string): boolean {
  const addr = address.toLowerCase();
  // IPv4 (including IPv4-mapped IPv6 like ::ffff:10.0.0.1)
  const v4 = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  if (IPV4_LITERAL.test(v4)) {
    const parts = v4.split(".").map(Number);
    if (parts.some((p) => p > 255)) return true; // malformed → treat as unsafe
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0) return true; // 192.0.0.0/24 special-purpose
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  // IPv6
  if (!addr.includes(":")) return true; // not an IP we understand → unsafe
  if (addr === "::" || addr === "::1") return true; // unspecified / loopback
  if (addr.startsWith("fe8") || addr.startsWith("fe9") || addr.startsWith("fea") || addr.startsWith("feb")) return true; // fe80::/10
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true; // fc00::/7 unique-local
  if (addr.startsWith("ff")) return true; // multicast
  if (addr.startsWith("64:ff9b")) return true; // NAT64 — could map to private v4
  if (addr.startsWith("2001:db8")) return true; // documentation
  return false;
}
