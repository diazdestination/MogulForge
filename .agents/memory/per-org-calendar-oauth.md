---
name: Per-org calendar OAuth
description: Routing + security rules for per-org Google/Outlook calendar connections vs the workspace connector.
---

Rule: new calendar events are created under the org's own OAuth connection when one exists (workspace Replit connector otherwise), and the credential source is PERSISTED with the event ref. All later reads/updates/deletes must use that stored source — never re-resolve dynamically — because looking an event up under a different account yields a false 404, and the pull loop treats 404 as "cancelled" (mass false cancellations). A broken/absent source account means skip, not fall back.

**Why:** falling back would push a client's bookings onto the platform owner's calendar — a cross-tenant data leak, worse than a failed sync.

**How to apply:** any new calendar API call goes through the org-aware request helper (org token first, workspace connector fallback decided by presence of a stored connection, not by token health). OAuth tokens are AES-256-GCM encrypted with a SESSION_SECRET-derived key — rotating SESSION_SECRET invalidates them; decrypt failures return null and require reconnect, never plaintext fallback. Google/Microsoft API paths are identical between the Replit connector proxy and direct googleapis/graph fetches, so one path string serves both transports.
