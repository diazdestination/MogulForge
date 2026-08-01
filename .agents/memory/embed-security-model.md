---
name: Embed security model decisions
description: Why embed tokens ride the iframe query string, and how origin/CSP enforcement is layered
---

Embed sessions are stateless HMAC tokens (no DB row) carrying org/modules/origin/expiry claims.

**Decision:** the token is passed in the iframe *query string* (not the URL fragment), so the root Next proxy can read it and emit a per-org `Content-Security-Policy: frame-ancestors 'self' <claimed origin>` header; without a valid token the page gets `frame-ancestors 'none'`.
**Why:** fragments never reach the server, so a fragment token would force a static, org-agnostic CSP. Query-string exposure is acceptable because tokens are short-lived (15 min default, 1 h max) and every embed API call re-validates token + `Origin` header against the org's allow-list anyway — CSP is one layer, not the only one.
**How to apply:** don't "fix" the token into the fragment or localStorage; if lengthening TTLs or logging URLs server-side, revisit this tradeoff.

Related patterns: token-verification lib must stay free of `import "server-only"` (the proxy and unit tests import it); embed pages hide the global site header/footer via CSS in the embed segment layout because the root layout renders them unconditionally.
