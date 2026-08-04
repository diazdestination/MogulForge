/**
 * Unit tests for bot-trap over-blocking monitoring:
 * - botSubmissionReason categorizes WHY the trap fired (honeypot vs missing
 *   timer vs too fast), staying consistent with isBotSubmission.
 * - computeBotTrapStats flags an unusual 24h spike vs the 7-day baseline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("./helpers/server-lib-loader.mjs", import.meta.url);

const { botSubmissionReason, isBotSubmission, MIN_SUBMIT_MS } = await import("../lib/visibility-schema.ts");
const { computeBotTrapStats, SPIKE_MIN_HITS, SPIKE_MULTIPLIER } = await import("../lib/bot-trap-metrics-core.ts");

const LEGIT = { url: "example.com", email: "a@b.com", elapsedMs: MIN_SUBMIT_MS + 500 };

test("botSubmissionReason categorizes each trigger", () => {
  assert.equal(botSubmissionReason(LEGIT), null);
  assert.equal(botSubmissionReason({ ...LEGIT, website: "x" }), "honeypot");
  // Honeypot wins even when elapsedMs is also bad — it's the strongest signal.
  assert.equal(botSubmissionReason({ ...LEGIT, website: "x", elapsedMs: 0 }), "honeypot");
  const { elapsedMs: _omit, ...noElapsed } = LEGIT;
  assert.equal(botSubmissionReason(noElapsed), "missing_elapsed");
  assert.equal(botSubmissionReason({ ...LEGIT, elapsedMs: "3000" }), "missing_elapsed");
  assert.equal(botSubmissionReason({ ...LEGIT, elapsedMs: NaN }), "missing_elapsed");
  assert.equal(botSubmissionReason({ ...LEGIT, elapsedMs: MIN_SUBMIT_MS - 1 }), "too_fast");
  assert.equal(botSubmissionReason({ ...LEGIT, elapsedMs: MIN_SUBMIT_MS }), null);
  assert.equal(botSubmissionReason(null), null);
  assert.equal(botSubmissionReason("string"), null);
});

test("isBotSubmission stays consistent with botSubmissionReason", () => {
  for (const body of [
    LEGIT,
    { ...LEGIT, website: "x" },
    { ...LEGIT, elapsedMs: 0 },
    { url: "example.com", email: "a@b.com" },
    null,
    42,
  ]) {
    assert.equal(isBotSubmission(body), botSubmissionReason(body) !== null);
  }
});

test("stats: totals and per-reason counts, missing reasons default to 0", () => {
  const stats = computeBotTrapStats({ last24h: { honeypot: 3 }, baselineTotal: 14 });
  assert.deepEqual(stats.last24h, { honeypot: 3, missing_elapsed: 0, too_fast: 0 });
  assert.equal(stats.last24hTotal, 3);
  assert.equal(stats.baselinePerDay, 2);
  assert.equal(stats.spike, false);
});

test("spike requires clearing BOTH the absolute floor and the baseline multiple", () => {
  // Above multiplier but below the absolute floor: not a spike (normal noise).
  assert.equal(
    computeBotTrapStats({ last24h: { too_fast: SPIKE_MIN_HITS - 1 }, baselineTotal: 0 }).spike,
    false,
  );
  // At the floor with no baseline: spike (trap suddenly firing from nothing).
  assert.equal(
    computeBotTrapStats({ last24h: { too_fast: SPIKE_MIN_HITS }, baselineTotal: 0 }).spike,
    true,
  );
  // Busy-but-normal: high volume that matches the baseline is NOT a spike.
  const busyBaseline = 7 * 100; // 100 hits/day
  assert.equal(
    computeBotTrapStats({ last24h: { too_fast: 150 }, baselineTotal: busyBaseline }).spike,
    false,
  );
  // Same baseline, 3x jump: spike.
  assert.equal(
    computeBotTrapStats({ last24h: { too_fast: 100 * SPIKE_MULTIPLIER }, baselineTotal: busyBaseline }).spike,
    true,
  );
  // Just under the multiple: not a spike.
  assert.equal(
    computeBotTrapStats({ last24h: { too_fast: 100 * SPIKE_MULTIPLIER - 1 }, baselineTotal: busyBaseline }).spike,
    false,
  );
});
