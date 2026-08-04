---
name: Logo URL SSRF policy
description: Tenant-controlled logo URLs are fetched server-side; every write path and fetch must enforce the safe-URL policy.
---

Org logo URLs are tenant/admin-controlled and are fetched **server-side** (portal favicon resizing), so they are an SSRF vector.

**Rule:** every mutation path that stores a logo URL must validate it with the shared pure checker (public http(s) hostname or same-app relative path; no IP literals, localhost, .local/.internal, credentials, or non-http schemes). Server-side fetches of such URLs must go through the pinned fetcher: resolve DNS yourself, reject private/loopback/link-local/CGNAT/NAT64 addresses, connect to the vetted IP (Host/SNI carry the hostname), never follow redirects, cap size and time.

**Why:** a completion review rejected shipping a server-side fetch of raw logoUrl — hostname validation alone doesn't stop DNS rebinding, and one unvalidated write path defeats checks on another.

**How to apply:** any new field that a tenant can set and the server later fetches (webhooks, images, imports) gets the same treatment; graceful fallback should redirect the *browser* to the raw URL (client-side fetch has no SSRF surface) only after the URL passes the shape check.
