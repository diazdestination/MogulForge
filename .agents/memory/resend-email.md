---
name: Resend email setup
description: Constraints on sending email via Resend for this project (domain verification pending)
---

The weekly lead digest sends via Resend's HTTP API (no SDK).

**Constraint:** Until the project's sending domain shows "Verified" in Resend, mail must be sent from `onboarding@resend.dev`, and Resend only delivers such mail to the Resend account's own address. DKIM/SPF records were provided for the registrar (July 2026); once the domain verifies, set `LEAD_DIGEST_FROM` to an address on that domain.

**Scheduling caveat:** production deployment target is autoscale, so the in-app hourly timer (`instrumentation.ts`) only fires while the server is warm. The digest is idempotent (row-locked state table, at most weekly), so any trigger cadence is safe; `POST /api/cron/lead-digest` accepts an admin session or `Authorization: Bearer $CRON_SECRET` for external cron if reliable timing is ever needed.
