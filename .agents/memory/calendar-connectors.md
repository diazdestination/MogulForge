---
name: Calendar connectors via Replit connectors SDK
description: How Google Calendar / Outlook / Calendly sync is wired and the constraint that connections are workspace-level, not per-org.
---

Rule: calendar provider auth uses workspace-level Replit connectors (`google-calendar`, `outlook`, `calendly`) through `@replit/connectors-sdk` (`listConnections` for state, `.proxy()` for authed calls) — there is no per-tenant OAuth; per-org behavior is layered on top via org settings (`calendar` section) choosing the sync target / Calendly link.

**Why:** Replit connectors authorize one account for the whole workspace; building true per-org OAuth would require our own Google/Microsoft client credentials, which the project doesn't have.

**How to apply:** any new provider sync should follow the same shape: live connection state resolved honestly at request time (never hardcoded "connected"), org preference in settings jsonb, best-effort push that never fails the primary write, inbound pull via a `/api/cron/*` endpoint + in-app timer. Connector calls fail closed (report not connected).

## Update (Aug 2026)
Workspace connectors are now the legacy fallback path only. Per-org OAuth connections (org_calendar_connections, see per-org-calendar-oauth.md) always take precedence when present. The rest of this file describes the fallback behavior.
