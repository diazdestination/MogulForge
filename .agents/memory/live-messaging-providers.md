---
name: Live messaging providers
description: Env conventions and honesty rules for live SMS/email campaign sending
---

- Live campaign sending is env-driven, platform-wide (not per-org): Twilio for SMS, Resend for outreach email. Outreach email uses `OUTREACH_RESEND_API_KEY`/`OUTREACH_EMAIL_FROM` — **never** reuse the internal `RESEND_API_KEY` (lead digest) for client outreach; it sends from an unverified shared sender.
- **Why:** honest provider status is a product guarantee here — simulation vs live must never blur, and the DB constraint `rescue_messages_simulation_honesty` backs it up.
- **How to apply:** any new outbound channel must (1) report disconnected unless fully configured, (2) write live rows `simulated=false` starting at `queued` and update honestly, (3) return 404 from its webhook while unconfigured, and (4) route inbound replies through the reply-service so opt-outs suppress automatically.
- Quiet hours are enforced by refusing live activation during the window (server local time) — there is no deferred-send scheduler yet (separate task covers scheduling).
- Twilio webhook signature = HMAC-SHA1 over the *public* URL (reconstruct from x-forwarded-host/proto behind Replit's proxy) + sorted params; Resend uses Svix HMAC-SHA256.
