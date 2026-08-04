---
name: SSRF guard vs REPLIT_DEV_DOMAIN
description: The dev domain resolves to a PRIVATE IP inside the container, so SSRF-guarded outbound fetches (visibility/site crawlers) refuse it.
---

The rule: any server-side fetch that goes through the private-host guard (`assertPublicHost` in the visibility/site crawler stack) cannot target `$REPLIT_DEV_DOMAIN` from inside the workspace.

**Why:** `getent hosts $REPLIT_DEV_DOMAIN` returns a 172.24.x.x private address inside the container (the proxy short-circuits locally), so the guard correctly blocks it — this is the SSRF protection working, not a bug. An earlier assumption that the dev domain is "public" from the server's own perspective was wrong.

**How to apply:** integration tests for crawler-style features must use a genuinely public target (e.g. `https://example.com/` with a small page cap) or unit-test the parsing/BFS logic separately. Asserting the 400 "private network" rejection for `127.0.0.1` AND for the dev domain is expected behavior.
