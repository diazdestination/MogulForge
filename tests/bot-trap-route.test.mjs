/**
 * Integration tests for the scan API's bot-trap fake-success path, over live
 * HTTP against the dev server (POST /api/ai-visibility):
 * - honeypot filled / too-fast / missing elapsedMs → 200 with result: null
 *   ("queued" fake success), even for a URL whose crawl would fail — proof
 *   the trap short-circuits before any crawl or AI spend
 * - a human-speed submission passes the trap and reaches validation
 *
 * Requires the dev server on port 5000. The trap writes only a bot_trap_hits
 * metric row (reason + timestamp) — never the bot's submitted data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.TEST_BASE_URL ?? "http://127.0.0.1:5000";
// A crawl of this URL would fail loudly (unresolvable host) — so a 200 fake
// success proves the request never reached the crawler.
const UNCRAWLABLE = "https://no-such-host.invalid";

async function scan(body) {
  const response = await fetch(`${BASE}/api/ai-visibility`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

test("filled honeypot gets a silent fake success with no crawl", async () => {
  const { status, json } = await scan({
    url: UNCRAWLABLE,
    email: "bot@example.com",
    website: "https://spam.example",
    elapsedMs: 9000,
  });
  assert.equal(status, 200);
  assert.deepEqual(json, { result: null, reportId: null, mode: "queued" });
});

test("too-fast submission gets the same fake success", async () => {
  const { status, json } = await scan({ url: UNCRAWLABLE, email: "bot@example.com", elapsedMs: 100 });
  assert.equal(status, 200);
  assert.deepEqual(json, { result: null, reportId: null, mode: "queued" });
});

test("missing elapsedMs gets the same fake success", async () => {
  const { status, json } = await scan({ url: UNCRAWLABLE, email: "bot@example.com" });
  assert.equal(status, 200);
  assert.deepEqual(json, { result: null, reportId: null, mode: "queued" });
});

test("human-speed submission passes the trap and reaches real processing", async () => {
  // elapsedMs at the threshold (autofill + ~2s pause) must NOT be treated as
  // a bot: with an uncrawlable URL the real pipeline responds with an error
  // (422 crawl failure, or 4xx from validation/abuse guards) — never the
  // trap's silent { result: null } 200.
  const { status, json } = await scan({ url: UNCRAWLABLE, email: "human@example.com", elapsedMs: 2000 });
  assert.notEqual(json?.mode, "queued");
  assert.ok(status >= 400 && status < 500, `expected a real 4xx, got ${status}`);
  assert.ok(json?.error, "expected a visible error, not a silent fake success");
});
