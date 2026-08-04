/**
 * Postgres-backed fixed-window rate limiter. Counters live in the
 * rate_limit_windows table so limits hold across autoscale instances and
 * process restarts. On database errors it fails over to a per-instance
 * in-memory limiter (limits are a protection, not a billing meter — better
 * degraded throttling than a broken public endpoint).
 */

import { getPool } from "./db";
import { FixedWindowRateLimiter, type RateLimitResult } from "./public-api/rate-limit";

export class DbFixedWindowRateLimiter {
  private limit: number;
  private windowMs: number;
  private fallback: FixedWindowRateLimiter;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.fallback = new FixedWindowRateLimiter(limit, windowMs);
  }

  async check(key: string, now = Date.now()): Promise<RateLimitResult> {
    const windowStart = Math.floor(now / this.windowMs) * this.windowMs;
    try {
      // Atomic upsert: start a fresh window when this one is newer, otherwise
      // increment the existing counter. GREATEST guards against clock skew
      // between instances rolling the window backwards.
      const { rows } = await getPool().query<{ window_start: string; count: number }>(
        `INSERT INTO rate_limit_windows (key, window_start, count)
         VALUES ($1, $2, 1)
         ON CONFLICT (key) DO UPDATE SET
           count = CASE
             WHEN EXCLUDED.window_start > rate_limit_windows.window_start THEN 1
             ELSE rate_limit_windows.count + 1
           END,
           window_start = GREATEST(rate_limit_windows.window_start, EXCLUDED.window_start)
         RETURNING window_start, count`,
        [key, windowStart],
      );
      const row = rows[0];
      const effectiveStart = Number(row.window_start);
      const count = row.count;
      // Opportunistic cleanup so stale keys don't accumulate forever.
      if (Math.random() < 0.02) {
        getPool()
          .query("DELETE FROM rate_limit_windows WHERE window_start < $1", [windowStart - this.windowMs])
          .catch(() => {});
      }
      return {
        allowed: count <= this.limit,
        limit: this.limit,
        remaining: Math.max(0, this.limit - count),
        resetAt: Math.ceil((effectiveStart + this.windowMs) / 1000),
      };
    } catch (error) {
      console.error("DB rate limiter unavailable; using in-memory fallback", error);
      return this.fallback.check(key, now);
    }
  }
}
