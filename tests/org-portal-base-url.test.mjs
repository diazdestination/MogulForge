/**
 * getOrgPortalBaseUrl against a real database:
 *   - org with no custom domain → SITE_URL fallback
 *   - org with a pending/verified (not active) domain → still SITE_URL
 *   - org with an active domain → https://<domain>
 *
 * Requires DATABASE_URL in the env. Run this file alone (not `npm test`).
 */
import { register } from "node:module";
register("./helpers/server-lib-loader.mjs", import.meta.url);
register("./helpers/dns-mock-loader.mjs", import.meta.url);

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const { getOrgPortalBaseUrl, requestCustomDomain, verifyCustomDomain, activateCustomDomain } =
  await import("../lib/custom-domains.ts");
const { SITE_URL } = await import("../lib/site.ts");
const { getPool } = await import("../lib/db.ts");

const ORG_A = "00000000-0000-4000-8000-00000000b8a1";
const ORG_B = "00000000-0000-4000-8000-00000000b8a2";
const DOMAIN = "portal.base-url-test.example.com";

async function cleanup() {
  const pool = getPool();
  await pool.query("DELETE FROM custom_domains WHERE organization_id = ANY($1::uuid[])", [[ORG_A, ORG_B]]);
  await pool.query("DELETE FROM organizations WHERE id = ANY($1::uuid[])", [[ORG_A, ORG_B]]);
}

before(async () => {
  await cleanup();
  const pool = getPool();
  await pool.query(
    "INSERT INTO organizations (id, name, slug) VALUES ($1, 'BaseUrl Test A', 'base-url-test-a'), ($2, 'BaseUrl Test B', 'base-url-test-b')",
    [ORG_A, ORG_B],
  );
});

after(async () => {
  await cleanup();
  await getPool().end();
});

test("org without a custom domain falls back to SITE_URL", async () => {
  assert.equal(await getOrgPortalBaseUrl(ORG_B), SITE_URL);
});

test("non-active domains do not change the base URL; active domain does", async () => {
  const record = await requestCustomDomain(ORG_A, DOMAIN);
  assert.equal(await getOrgPortalBaseUrl(ORG_A), SITE_URL, "pending domain must not be used");

  await verifyCustomDomain(ORG_A, record.id, { force: true });
  assert.equal(await getOrgPortalBaseUrl(ORG_A), SITE_URL, "verified-but-inactive domain must not be used");

  const activated = await activateCustomDomain(ORG_A, record.id);
  assert.equal(activated.ok, true, activated.reason ?? "");
  assert.equal(await getOrgPortalBaseUrl(ORG_A), `https://${DOMAIN}`);
});
