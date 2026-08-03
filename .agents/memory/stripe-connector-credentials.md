---
name: Stripe connector credential shape
description: The Replit Stripe connection returns different settings keys than the skill template expects; proxyFetch/getClient don't work for Stripe.
---

The Stripe connection on this workspace (sandbox-based, added Aug 2026) exposes credentials at
`settings.secret` / `settings.publishable` / `settings.account_id` — NOT `settings.secret_key`
as the stripe skill's `stripeClient.ts` template reads. Code should try `settings.secret ?? settings.secret_key`.

**Why:** Verification against the live connection API showed `settings keys: account_id,secret,publishable,mcp,claim_url`.
The template's `secret_key` lookup returns undefined and throws "integration not connected".

**How to apply:** Any Stripe client bootstrap (main app or merged task code) must handle both key names.
After a billing task merge, verify the merged `stripeClient` actually authenticates before trusting it.
Also: the sandbox connection has `hasClient: false` and its `proxyFetch` 404s on all `/v1/*` paths —
fetch credentials from `$REPLIT_CONNECTORS_HOSTNAME/api/v2/connection?include_secrets=true&connector_names=stripe`
and call the Stripe API/SDK directly instead.

Current connection (temporary, to be swapped for the user's LLC account later): test-mode sandbox,
dashboard name "MogulForge Sandbox", US/USD, `sk_test_` key. Swapping accounts later = reconnect the
integration; runtime credential fetch means no code changes, but products/prices must be re-seeded
in the new account.
