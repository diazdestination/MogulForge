/**
 * Server-side wiring for the visibility scan guard: Postgres-backed limiters
 * shared across autoscale instances. Kept separate from lib/visibility-guard.ts
 * so the pure guard logic stays unit-testable under node --test.
 */

import { DbFixedWindowRateLimiter } from "./rate-limit-db";
import { VISIBILITY_WINDOW_MS, visibilityLimits, type VisibilityLimiters } from "./visibility-guard";

function createDbVisibilityLimiters(): VisibilityLimiters {
  const limits = visibilityLimits();
  return {
    ip: new DbFixedWindowRateLimiter(limits.ip, VISIBILITY_WINDOW_MS),
    email: new DbFixedWindowRateLimiter(limits.email, VISIBILITY_WINDOW_MS),
  };
}

const globalState = globalThis as typeof globalThis & { __visibilityLimiters?: VisibilityLimiters };

export function getVisibilityLimiters(): VisibilityLimiters {
  globalState.__visibilityLimiters ??= createDbVisibilityLimiters();
  return globalState.__visibilityLimiters;
}
