---
name: Admin org provisioning shape
description: Correct field names for the admin org creation API and related tables — easy to get wrong.
---

**Rule:** POST /api/admin/organizations returns `{ organizationId, slug, inviteToken }` — NOT `{ organization: { id } }` or `{ inviteCode }`.

Owner email must be nested: `{ owner: { email: "..." } }`, not `{ ownerEmail: "..." }`.

**Entitlements table** is named `entitlements` (not `org_entitlements`). Query: `SELECT ... FROM entitlements WHERE organization_id = $1 AND feature_key = $2`.

**Why:** These field name mismatches cause `jq` extractions to return `null`, making every downstream step fail silently. The smoke test pattern in other tests (site-health.test.mjs) uses the test helper which abstracts these — raw curl tests must use the correct field names above.

**How to apply:** Any raw curl / fetch smoke test provisioning an org must use `organizationId` and `inviteToken` from the creation response. Any DB query joining entitlements must use the `entitlements` table.
