/**
 * Unit tests for the scan form's bot trap (lib/visibility-schema.ts +
 * lib/bot-trap.ts): honeypot detection, time-to-submit thresholds, and the
 * client timer used to measure elapsed time — including the autofill-style
 * "real human submits quickly" cases that must NOT be flagged as bots.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
register("./helpers/server-lib-loader.mjs", import.meta.url);

const { isBotSubmission, MIN_SUBMIT_MS } = await import("../lib/visibility-schema.ts");
const { createSubmitTimer } = await import("../lib/bot-trap.ts");

const LEGIT = { url: "example.com", email: "a@b.com", elapsedMs: MIN_SUBMIT_MS + 500 };

test("legitimate submission passes (empty honeypot, human-speed elapsed)", () => {
  assert.equal(isBotSubmission(LEGIT), false);
  assert.equal(isBotSubmission({ ...LEGIT, website: "" }), false);
  assert.equal(isBotSubmission({ ...LEGIT, website: "   " }), false); // whitespace-only is not "filled"
});

test("filled honeypot is flagged even with a slow submit", () => {
  assert.equal(isBotSubmission({ ...LEGIT, website: "https://spam.example" }), true);
  assert.equal(isBotSubmission({ ...LEGIT, website: "x", elapsedMs: 60_000 }), true);
});

test("too-fast submissions are flagged; the exact threshold passes", () => {
  assert.equal(isBotSubmission({ ...LEGIT, elapsedMs: 0 }), true);
  assert.equal(isBotSubmission({ ...LEGIT, elapsedMs: MIN_SUBMIT_MS - 1 }), true);
  // Boundary: an autofill-assisted human submitting right at the threshold
  // must NOT be blocked.
  assert.equal(isBotSubmission({ ...LEGIT, elapsedMs: MIN_SUBMIT_MS }), false);
});

test("missing or malformed elapsedMs is flagged", () => {
  const { elapsedMs: _omit, ...noElapsed } = LEGIT;
  assert.equal(isBotSubmission(noElapsed), true);
  assert.equal(isBotSubmission({ ...LEGIT, elapsedMs: "3000" }), true);
  assert.equal(isBotSubmission({ ...LEGIT, elapsedMs: NaN }), true);
  assert.equal(isBotSubmission({ ...LEGIT, elapsedMs: Infinity }), true);
});

test("non-object bodies are left for schema validation, not the trap", () => {
  assert.equal(isBotSubmission(null), false);
  assert.equal(isBotSubmission("string"), false);
  assert.equal(isBotSubmission(42), false);
});

test("submit timer measures from start(), and reports 0 before start", async () => {
  const timer = createSubmitTimer();
  assert.equal(timer.elapsedMs(), 0); // unstarted timer must not fake a big elapsed
  timer.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const elapsed = timer.elapsedMs();
  assert.ok(elapsed >= 25 && elapsed < 2000, `expected ~30ms, got ${elapsed}`);
});

test("autofill scenario: timer runs from mount, so a human pausing >2s passes even with instant autofill", async () => {
  // Browser autofill populates fields instantly at mount; what protects the
  // user is that elapsed time is measured from form mount, not from typing.
  const timer = createSubmitTimer();
  timer.start(); // form mount
  // (autofill fills url + email here, at ~0ms — no timer interaction)
  const body = { url: "example.com", email: "a@b.com", elapsedMs: timer.elapsedMs() };
  // An instant submit IS flagged — that's the trap working as intended…
  assert.equal(isBotSubmission(body), true);
  // …but any human-scale pause before clicking submit clears the threshold.
  assert.equal(
    isBotSubmission({ ...body, elapsedMs: timer.elapsedMs() + MIN_SUBMIT_MS }),
    false,
  );
});

test("form wiring guards: honeypot stays autofill-proof and elapsedMs is sent", () => {
  // Regression guard on components/visibility-form.tsx: the honeypot input
  // must opt out of autofill/tab focus (or autofill would fill it and block
  // real users), and the submit payload must include the measured elapsedMs.
  const source = readFileSync(new URL("../components/visibility-form.tsx", import.meta.url), "utf8");
  const honeypot = source.match(/\{\.\.\.register\("website"\)\}[^/]*\/>/)?.[0];
  assert.ok(honeypot, "honeypot input (register(\"website\")) not found");
  assert.match(honeypot, /autoComplete="off"/);
  assert.match(honeypot, /tabIndex=\{-1\}/);
  assert.match(source, /elapsedMs:\s*timer\.elapsedMs\(\)/);
  assert.match(source, /timer\.start\(\)/);
});
