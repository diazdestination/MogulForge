/**
 * Server-side wiring for the public API rate limiter: Postgres-backed
 * fixed-window counters shared across autoscale instances, so per-API-key
 * limits survive restarts and hold across servers. Kept separate from
 * lib/public-api/rate-limit.ts so the pure limiter stays unit-testable
 * under node --test.
 */

import "server-only";
import { DbFixedWindowRateLimiter } from "../rate-limit-db";
import { PUBLIC_API_WINDOW_MS, publicApiRateLimit } from "./rate-limit";

const globalState = globalThis as typeof globalThis & {
  __publicApiRateLimiter?: DbFixedWindowRateLimiter;
};

export function getPublicApiRateLimiter(): DbFixedWindowRateLimiter {
  globalState.__publicApiRateLimiter ??= new DbFixedWindowRateLimiter(
    publicApiRateLimit(),
    PUBLIC_API_WINDOW_MS,
  );
  return globalState.__publicApiRateLimiter;
}
