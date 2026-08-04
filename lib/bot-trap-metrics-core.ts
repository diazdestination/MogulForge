// Pure aggregation/spike logic for scan-form bot-trap monitoring.
// Kept DB-free so it can be unit-tested directly (see tests/bot-trap-metrics-unit.test.mjs).
import type { BotTrapReason } from "@/lib/visibility-schema";

export type BotTrapReasonCounts = Record<BotTrapReason, number>;

export type BotTrapStats = {
  /** Hits in the last 24 hours, by trigger. */
  last24h: BotTrapReasonCounts;
  last24hTotal: number;
  /** Average hits per day over the 7 days BEFORE the last 24 hours. */
  baselinePerDay: number;
  /** Total hits over that 7-day baseline window. */
  baselineTotal: number;
  /** True when the last 24h looks abnormally high vs. the baseline. */
  spike: boolean;
};

// A spike must clear an absolute floor (a handful of bots is normal noise)
// AND a relative multiple of the recent baseline. With no baseline at all,
// only the absolute floor applies.
export const SPIKE_MIN_HITS = 20;
export const SPIKE_MULTIPLIER = 3;

export function emptyReasonCounts(): BotTrapReasonCounts {
  return { honeypot: 0, missing_elapsed: 0, too_fast: 0 };
}

export function computeBotTrapStats(input: {
  last24h: Partial<BotTrapReasonCounts>;
  baselineTotal: number;
}): BotTrapStats {
  const last24h = { ...emptyReasonCounts(), ...input.last24h };
  const last24hTotal = last24h.honeypot + last24h.missing_elapsed + last24h.too_fast;
  const baselineTotal = Math.max(0, input.baselineTotal);
  const baselinePerDay = baselineTotal / 7;
  const spike =
    last24hTotal >= SPIKE_MIN_HITS &&
    last24hTotal >= baselinePerDay * SPIKE_MULTIPLIER;
  return { last24h, last24hTotal, baselinePerDay, baselineTotal, spike };
}
