/**
 * "Check now" probe (checkCustomDomain) end-to-end against a real database,
 * with DNS lookups mocked via a loader hook so outcomes are deterministic:
 *   - pending domain + bad DNS: verified stays false, error persisted on the
 *     record (last_check_error / last_checked_at)
 *   - pending → verified transition sets newlyVerified exactly once
 *   - active domain check reports the routing-live message
 *   - removed domains return null
 *
 * Requires DATABASE_URL in the env. Run this file alone (not `npm test`).
 */
import { register } from "node:module";
register("./helpers/server-lib-loader.mjs", import.meta.url);
register("./helpers/dns-mock-loader.mjs", import.meta.url);

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const TARGET = "portal-target.test-probe.example.com";
process.env.CUSTOM_DOMAIN_CNAME_TARGET = TARGET;

// Default: all lookups fail like unresolvable DNS.
const notFound = () => {
  const err = new Error("queryTxt ENOTFOUND");
  err.code = "ENOTFOUND";
  return Promise.reject(err);
};
globalThis.__dnsMock = { resolveTxt: notFound, resolveCname: notFound };

const { checkCustomDomain, requestCustomDomain, activateCustomDomain, getCustomDomain } =
  await import("../lib/custom-domains.ts");
const { getPool } = await import("../lib/db.ts");

const RUN = `cp${Date.now().toString(36)}`;
const DOMAIN = `portal.test-${RUN}.example.com`;
const state = {};

async function cleanup() {
  await getPool().query("DELETE FROM organizations WHERE slug LIKE 'test-cp%'");
}

before(async () => {
  await cleanup();
  const { rows } = await getPool().query(
    "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
    [`Test ${RUN} Probe`, `test-${RUN}`],
  );
  state.org = rows[0].id;
  const domain = await requestCustomDomain(state.org, DOMAIN);
  state.domainId = domain.id;
  assert.equal(domain.status, "pending_dns");
  assert.equal(domain.lastCheckedAt, null);
});

after(async () => {
  await cleanup();
  await getPool().end();
});

test("pending domain with bad DNS records the failure, stays pending", async () => {
  const result = await checkCustomDomain(state.org, state.domainId);
  assert.ok(result);
  assert.equal(result.verified, false);
  assert.equal(result.newlyVerified, false);
  assert.equal(result.cnameOk, false);
  assert.match(result.message, /TXT record not found yet \(ENOTFOUND\)/);
  assert.match(result.message, new RegExp(`No CNAME record found for ${DOMAIN} yet`));
  assert.match(result.message, new RegExp(`pointing at ${TARGET}`));
  assert.equal(result.domain.status, "pending_dns");

  // Persisted on the record, not just in the return value.
  const stored = await getCustomDomain(state.org, state.domainId);
  assert.equal(stored.status, "pending_dns");
  assert.equal(stored.lastCheckError, result.message);
  assert.ok(stored.lastCheckedAt, "last_checked_at should be set");
  assert.equal(stored.verifiedAt, null);
});

test("TXT ok but wrong CNAME: verified flips, CNAME error persisted", async () => {
  const record = await getCustomDomain(state.org, state.domainId);
  globalThis.__dnsMock.resolveTxt = async () => [[`mogulforge-verify=${record.verificationToken}`]];
  globalThis.__dnsMock.resolveCname = async () => ["wrong.example.net"];

  const result = await checkCustomDomain(state.org, state.domainId);
  assert.equal(result.verified, true);
  assert.equal(result.newlyVerified, true, "pending → verified must set newlyVerified");
  assert.equal(result.cnameOk, false);
  assert.equal(result.domain.status, "verified");
  assert.ok(result.domain.verifiedAt);
  assert.match(result.message, /CNAME record points at wrong\.example\.net instead of/);
  assert.doesNotMatch(result.message, /TXT/);

  const stored = await getCustomDomain(state.org, state.domainId);
  assert.equal(stored.status, "verified");
  assert.equal(stored.lastCheckError, result.message);
});

test("repeat check after verification does not set newlyVerified again", async () => {
  globalThis.__dnsMock.resolveCname = async () => [TARGET];
  const result = await checkCustomDomain(state.org, state.domainId);
  assert.equal(result.verified, true);
  assert.equal(result.newlyVerified, false, "newlyVerified must fire only on the transition");
  assert.equal(result.cnameOk, true);
  assert.equal(result.message, `Domain verified and the CNAME points at ${TARGET}.`);

  const stored = await getCustomDomain(state.org, state.domainId);
  assert.equal(stored.lastCheckError, null, "clean check must clear last_check_error");
});

test("active domain check reports routing-live message", async () => {
  const activation = await activateCustomDomain(state.org, state.domainId);
  assert.equal(activation.ok, true, activation.reason ?? "");

  const result = await checkCustomDomain(state.org, state.domainId);
  assert.equal(result.verified, true);
  assert.equal(result.newlyVerified, false);
  assert.equal(result.cnameOk, true);
  assert.equal(result.message, `Routing is live and the CNAME points at ${TARGET}.`);
  assert.equal(result.domain.status, "active");
});

test("removed domains return null", async () => {
  await getPool().query("UPDATE custom_domains SET status = 'removed' WHERE id = $1", [state.domainId]);
  assert.equal(await checkCustomDomain(state.org, state.domainId), null);
  // Unknown ids too.
  assert.equal(await checkCustomDomain(state.org, "00000000-0000-0000-0000-000000000000"), null);
});
