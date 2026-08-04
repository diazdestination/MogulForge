/**
 * Abuse protection for the public AI Visibility scan endpoint.
 *
 * The endpoint is unauthenticated and each request triggers a site crawl plus
 * an OpenAI call, so it needs per-IP and per-email throttling and basic junk
 * filtering (disposable email domains). Pure logic — no server-only imports —
 * so it stays unit-testable under node --test.
 */

import { FixedWindowRateLimiter } from "./public-api/rate-limit.ts";

export type GuardVerdict =
  | { allowed: true }
  | { allowed: false; status: number; error: string; retryAfterSeconds?: number };

/** Well-known disposable / throwaway email domains. Not exhaustive — a cheap first line. */
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.net",
  "guerrillamail.org",
  "sharklasers.com",
  "10minutemail.com",
  "10minutemail.net",
  "temp-mail.org",
  "tempmail.com",
  "tempmail.net",
  "tempmailo.com",
  "throwawaymail.com",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
  "getnada.com",
  "nada.email",
  "maildrop.cc",
  "dispostable.com",
  "trashmail.com",
  "trashmail.de",
  "mailnesia.com",
  "mintemail.com",
  "mytemp.email",
  "fakeinbox.com",
  "spamgourmet.com",
  "mohmal.com",
  "mailcatch.com",
  "emailondeck.com",
  "burnermail.io",
  "moakt.com",
  "tmpmail.org",
  "tmpmail.net",
  "discard.email",
  "inboxkitten.com",
  "harakirimail.com",
]);

/** Returns true when the email uses a known disposable/throwaway provider. */
export function isDisposableEmail(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at === -1) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  // Match the domain or any subdomain of a listed provider.
  if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) return true;
  for (const listed of DISPOSABLE_EMAIL_DOMAINS) {
    if (domain.endsWith(`.${listed}`)) return true;
  }
  return false;
}

/** Extracts the client IP from proxy headers; falls back to "unknown". */
export function clientIpFromHeaders(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip")?.trim() || "unknown";
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export type VisibilityLimiters = {
  ip: FixedWindowRateLimiter;
  email: FixedWindowRateLimiter;
};

const WINDOW_MS = 10 * 60_000; // 10 minutes

export function createVisibilityLimiters(env: Record<string, string | undefined> = process.env): VisibilityLimiters {
  return {
    // Generous for humans (a person rarely runs more than a few scans in
    // 10 minutes) while capping what a single bot IP or email can burn.
    ip: new FixedWindowRateLimiter(positiveInt(env.VISIBILITY_SCAN_IP_LIMIT, 5), WINDOW_MS),
    email: new FixedWindowRateLimiter(positiveInt(env.VISIBILITY_SCAN_EMAIL_LIMIT, 3), WINDOW_MS),
  };
}

const globalState = globalThis as typeof globalThis & { __visibilityLimiters?: VisibilityLimiters };

export function getVisibilityLimiters(): VisibilityLimiters {
  globalState.__visibilityLimiters ??= createVisibilityLimiters();
  return globalState.__visibilityLimiters;
}

/**
 * Runs all abuse checks for a scan request. Order matters: junk email is a
 * hard reject (does not consume rate-limit quota framing), then IP throttle,
 * then per-email throttle.
 */
export function checkScanRequest(
  limiters: VisibilityLimiters,
  input: { ip: string; email: string },
  now = Date.now(),
): GuardVerdict {
  if (isDisposableEmail(input.email)) {
    return {
      allowed: false,
      status: 400,
      error: "Please use your real business or personal email — disposable addresses can't receive the report.",
    };
  }

  const ipResult = limiters.ip.check(`ip:${input.ip}`, now);
  if (!ipResult.allowed) {
    return {
      allowed: false,
      status: 429,
      error: "You've requested several scans in a short time. Please wait a few minutes and try again.",
      retryAfterSeconds: Math.max(1, ipResult.resetAt - Math.floor(now / 1000)),
    };
  }

  const emailResult = limiters.email.check(`email:${input.email.trim().toLowerCase()}`, now);
  if (!emailResult.allowed) {
    return {
      allowed: false,
      status: 429,
      error: "We've already run several scans for this email recently. Please wait a few minutes and try again.",
      retryAfterSeconds: Math.max(1, emailResult.resetAt - Math.floor(now / 1000)),
    };
  }

  return { allowed: true };
}
