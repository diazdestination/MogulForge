/**
 * In-memory fixed-window rate limiter for the public API, keyed by API key id.
 * Suitable for a single-instance deployment; counters reset when the process
 * restarts (documented behavior — limits are a protection, not a billing meter).
 */

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix epoch seconds when the current window resets. */
  resetAt: number;
};

export class FixedWindowRateLimiter {
  private windows = new Map<string, { windowStart: number; count: number }>();
  private limit: number;
  private windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  check(key: string, now = Date.now()): RateLimitResult {
    const windowStart = Math.floor(now / this.windowMs) * this.windowMs;
    const entry = this.windows.get(key);
    if (!entry || entry.windowStart !== windowStart) {
      this.windows.set(key, { windowStart, count: 1 });
      if (this.windows.size > 10_000) this.prune(windowStart);
      return { allowed: true, limit: this.limit, remaining: this.limit - 1, resetAt: Math.ceil((windowStart + this.windowMs) / 1000) };
    }
    entry.count += 1;
    const allowed = entry.count <= this.limit;
    return {
      allowed,
      limit: this.limit,
      remaining: Math.max(0, this.limit - entry.count),
      resetAt: Math.ceil((entry.windowStart + this.windowMs) / 1000),
    };
  }

  private prune(currentWindowStart: number) {
    for (const [key, entry] of this.windows) {
      if (entry.windowStart !== currentWindowStart) this.windows.delete(key);
    }
  }
}

const DEFAULT_LIMIT = Number(process.env.PUBLIC_API_RATE_LIMIT ?? 120);

const globalState = globalThis as typeof globalThis & { __publicApiRateLimiter?: FixedWindowRateLimiter };

export function getPublicApiRateLimiter() {
  globalState.__publicApiRateLimiter ??= new FixedWindowRateLimiter(
    Number.isFinite(DEFAULT_LIMIT) && DEFAULT_LIMIT > 0 ? DEFAULT_LIMIT : 120,
    60_000,
  );
  return globalState.__publicApiRateLimiter;
}
