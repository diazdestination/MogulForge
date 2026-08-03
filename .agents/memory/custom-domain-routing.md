---
name: Custom-domain host routing
description: How live host-header routing for client custom domains works and testing gotchas.
---

- Rule: only `custom_domains.status='active'` rows ever route; host resolution is per-request cached in a server lib, and `proxy.ts` (Next middleware) stays DB-free — it only does pure env/host checks and rewrites `/` on non-platform hosts to a dynamic page that does the DB lookup.
  **Why:** middleware runs on every request; DB lookups there add latency and Node/edge coupling.
  **How to apply:** any new host-aware behavior should consume the cached portal-host context, not re-read headers or query the DB itself.
- SSL honesty: `ssl_status` flips pending→issued only when a real request with `x-forwarded-proto: https` arrives on the active domain — never assumed at activation.
- Testing gotcha: undici `fetch` silently strips a spoofed `Host` header; host-based routing tests must use `node:http.request` and also send `X-Forwarded-Host` (which the app prefers).
