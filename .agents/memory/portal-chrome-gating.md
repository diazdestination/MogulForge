---
name: Portal chrome host-gating
description: How custom-domain hosts get org-branded chrome and lose marketing routes
---

Root layout awaits the cached portal-host resolution and swaps the MogulForge header/footer for minimal org-branded chrome on non-platform hosts; marketing paths are blocked in the proxy (redirect to "/"), not per-page.

**Why:** the proxy must stay DB-free, so the host→org lookup lives in the layout/pages (React cache shares one lookup per request). Reading headers in the root layout makes every route server-rendered on demand — accepted tradeoff, verified by next build.

**How to apply:** when adding new top-level routes, decide whether they belong on custom-domain hosts; if yes, add the prefix to PORTAL_PATH_PREFIXES in proxy.ts, otherwise they auto-redirect to the portal.
