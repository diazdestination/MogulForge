---
name: Embed dev-environment testing quirks
description: How to exercise token-gated embed pages locally, and the DB-pool hang killed HTTP tests cause.
---

- Embed API origin checks compare the browser Origin/Referer to the token's origin claim; in dev the app origin comparison can still 403, so to view /embed/* pages locally, add the dev origin (e.g. http://127.0.0.1:5000) to the org's allowed origins and mint the embed session for that origin.
- **Why:** frame-ancestors + origin pinning is the embed security model; there is no dev bypass.
- If HTTP integration tests suddenly hang at "TAP version 13" and even simple API routes take minutes: killed/timed-out test runs can leave the dev server's PG pool saturated. Restart the workflow before re-running instead of debugging routes.
