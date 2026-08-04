/**
 * Integration test for the Postgres-backed fixed-window rate limiter.
 * Requires DATABASE_URL and the rate_limit_windows migration applied.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("./helpers/server-lib-loader.mjs", import.meta.url);

const { DbFixedWindowRateLimiter } = await import("../lib/rate-limit-db.ts");
const { getPool } = await import("../lib/db.ts");

const WINDOW_MS = 10 * 60_000;
const now = 1_800_000_000_000;
const key = (suffix) => `test:${process.pid}:${suffix}`;

test.after(async () => {
  await getPool().query("DELETE FROM rate_limit_windows WHERE key LIKE $1", [`test:${process.pid}:%`]);
  await getPool().end();
});

test("counts persist in Postgres across limiter instances (simulates multiple servers)", async () => {
  const a = new DbFixedWindowRateLimiter(2, WINDOW_MS);
  const b = new DbFixedWindowRateLimiter(2, WINDOW_MS);
  assert.equal((await a.check(key("shared"), now)).allowed, true);
  // A different instance (different process/server in prod) sees the count.
  const second = await b.check(key("shared"), now);
  assert.equal(second.allowed, true);
  assert.equal(second.remaining, 0);
  const third = await a.check(key("shared"), now + 1000);
  assert.equal(third.allowed, false);
  assert.ok(third.resetAt > Math.floor(now / 1000));
});

test("window resets after it elapses", async () => {
  const limiter = new DbFixedWindowRateLimiter(1, WINDOW_MS);
  assert.equal((await limiter.check(key("reset"), now)).allowed, true);
  assert.equal((await limiter.check(key("reset"), now + 1000)).allowed, false);
  assert.equal((await limiter.check(key("reset"), now + 11 * 60_000)).allowed, true);
});

test("falls back to in-memory limiting during a DB outage and recovers after", async () => {
  const limiter = new DbFixedWindowRateLimiter(2, WINDOW_MS);
  const pool = getPool();
  const realQuery = pool.query;
  // Simulate a database hiccup: every query rejects.
  pool.query = () => Promise.reject(new Error("simulated db outage"));
  try {
    const first = await limiter.check(key("outage"), now);
    assert.equal(first.allowed, true);
    assert.equal(first.limit, 2);
    assert.equal(first.remaining, 1);
    assert.equal(first.resetAt, Math.ceil((Math.floor(now / WINDOW_MS) * WINDOW_MS + WINDOW_MS) / 1000));

    const second = await limiter.check(key("outage"), now + 1000);
    assert.equal(second.allowed, true);
    assert.equal(second.remaining, 0);

    // Third request in the same window is throttled by the in-memory fallback.
    const third = await limiter.check(key("outage"), now + 2000);
    assert.equal(third.allowed, false);
    assert.equal(third.limit, 2);
    assert.equal(third.remaining, 0);
    assert.ok(third.resetAt > Math.floor(now / 1000), "resetAt stays a sane future epoch-seconds value");
  } finally {
    pool.query = realQuery;
  }

  // Recovery: with the DB back, counting resumes against the shared table.
  const recovered = await limiter.check(key("outage"), now + 3000);
  assert.equal(recovered.allowed, true, "shared counter starts fresh; fallback counts were per-instance only");
  assert.equal(recovered.remaining, 1);
  const { rows } = await getPool().query(
    "SELECT count FROM rate_limit_windows WHERE key = $1",
    [key("outage")],
  );
  assert.equal(rows.length, 1, "post-recovery check is recorded in the shared table");
  assert.equal(rows[0].count, 1);
  // A second limiter instance (another server) sees the shared count.
  const other = new DbFixedWindowRateLimiter(2, WINDOW_MS);
  const shared = await other.check(key("outage"), now + 4000);
  assert.equal(shared.allowed, true);
  assert.equal(shared.remaining, 0);
  assert.equal((await other.check(key("outage"), now + 5000)).allowed, false);
});

test("concurrent checks never exceed the limit (atomic upsert)", async () => {
  const limiter = new DbFixedWindowRateLimiter(3, WINDOW_MS);
  const results = await Promise.all(
    Array.from({ length: 8 }, () => limiter.check(key("burst"), now)),
  );
  assert.equal(results.filter((r) => r.allowed).length, 3);
});
