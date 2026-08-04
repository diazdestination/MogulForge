# Changelog

All notable changes to MogulForge GrowthOS are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/). Versioning follows [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### In Progress
- Campaign reliability for 500+ lead activations
- Concurrent activation with partial AI failure handling
- Calendly reschedule and cancellation event sync

---

## [0.9.0] — 2026-08-04

### Added — Discovery Engine
- **Opportunity engine** with four signal adapters: stale estimates (>60 days), hot uncontacted leads, site pages missing a CTA, and Search Console low-CTR queries
- **Google Business Profile signal** — surfaces unanswered reviews via `business.manage` OAuth scope (fail-closed when scope not granted)
- **Opportunity card UI** at `/dashboard/revenue-rescue/opportunities` — badged by kind, act/dismiss workflow, show-dismissed toggle
- **Closer briefing** on every lead detail page — GPT-4o-mini analysis on demand, cached in `lead_closer_briefings`, regeneratable
- **Organic wins tracker** — "First job without ads" banner on the Reports page showing leads that closed without paid attribution
- `POST /api/cron/discovery` cron entry point (CRON_SECRET bearer or admin session), registered in scheduler status card
- `GET /api/orgs/[orgId]/opportunities` — list opportunities (member+)
- `PATCH /api/orgs/[orgId]/opportunities/[id]` — update status (manager+)
- `GET /api/orgs/[orgId]/organic-wins` — organic wins stat
- `GET|POST /api/orgs/[orgId]/leads/[leadId]/briefing` — get or generate closer briefing
- Database: `org_discovery_runs`, `org_opportunities`, `lead_closer_briefings` tables (migration 013)
- "Opportunities" link added to Revenue Rescue nav

### Added — Platform Reliability
- **Bounded concurrency** (8 workers) for AI drafting during campaign activation — prevents queue starvation on large campaigns
- **Duplicate lead prevention** for phone numbers arriving with a `+1` country code prefix
- **Advisory lock** preventing two servers from pulling the same CRM connection simultaneously
- **Bot-trap spike alert email** fires when automated submissions exceed threshold
- **CRM outage and recovery emails** now link to the client's branded portal, not the platform URL
- **Plan-change backoff** with exponential retry spacing — broken billing providers are no longer hammered on every cron pass

### Added — Calendar
- **Outlook bookings** now credit the correct client's calendar with per-org OAuth
- Booking link click tracking (`campaign_link_clicks` table, migration 014)
- Campaign click-through rate visible alongside booking rate in reports

### Fixed
- Dismissed opportunities correctly excluded from default feed; shown when `includeDismissed=true`
- Suppressed and won/lost leads no longer appear as discovery opportunities
- Discovery engine correctly skips orgs without the `revenue_rescue` entitlement
- Old dismissed opportunities pruned by the log-cleanup cron (retention: 90 days)
- Bot-trap cleanup cron confirmed running on schedule
- CRM outage recovery email fires reliably when a broken connection succeeds again

---

## [0.8.0] — 2026-07

### Added — Operations & Alerting
- Stale-scheduler detection — alert email fires when the cron goes quiet for too long
- Per-job heartbeat tracking — each cron job is tracked independently in `cron_heartbeat`
- Bot trap hit log with cleanup job — table stays bounded
- Site health and CRM cleanup jobs wired to external scheduler
- Admin email on bot-trap spike activity

### Added — White-Label
- Portal tab icon cache — favicon rebuilt once, cached; repeat visits skip the fetch
- Custom domain recovery email when a broken domain passes its DNS check
- CRM alert emails (outage, recovery) link to branded portal, not platform URL

### Fixed
- Concurrent CRM pull requests no longer race — advisory lock ensures one server wins
- Plan-change failure admin email delivers end to end
- Campaign booking link correctly credits campaign in analytics
- AI follow-up drafts can never ship without opt-out wording (linter + runtime check)
- Failing plan-change admin email delivers reliably

---

## [0.7.0] — 2026-06

### Added — Calendar & Scheduling
- Per-org OAuth for Google Calendar and Outlook (client's own account, not workspace connector)
- Calendly booking links — bookings credit the right campaign end to end
- Calendar connection health monitoring — alert email when sync stops
- Per-org calendar OAuth always wins over workspace-level connector fallback

### Added — CRM
- HubSpot and GoHighLevel CRM sync with full retry queue and exponential backoff
- CRM pull runs on schedule (every 15 min) — no longer requires manual trigger
- Failed CRM lead deliveries visible in the dashboard with one-click retry

### Fixed
- CRM inbound pull only updates existing leads — does not create unmatched contacts
- Calendar connection failure never falls back to another org's connection

---

## [0.6.0] — 2026-05

### Added — Campaigns
- Multi-step SMS + email sequences with AI-drafted messages
- AI sequence message drafting — all steps enforce opt-out wording
- Quiet-hours enforcement by business time zone
- Campaign message variation — repeat touches use reworded messages
- Campaign booking link inserted into message templates via one-click

### Added — Public API & Embeds
- Public API with bearer auth and rate limiting
- Webhook delivery with retry queue
- Embeddable widget with per-org CSP and short-lived tokens
- Embed theme preview in the dashboard

---

## [0.5.0] — 2026-04

### Added — Revenue Rescue Foundation
- CSV / XLSX / JSON lead import pipeline with auto-column mapping
- AI lead scoring (GPT-4o-mini) with deterministic signals fallback
- Suppression list management (STOP texts, email bounces, manual)
- Dashboard: leads list, campaign builder, reports, team settings
- Plan definitions with Stripe-backed subscription management
- Self-serve plan upgrade/downgrade (deferred to billing period end)

---

## [0.4.0] — 2026-03

### Added — White-Label Infrastructure
- Custom domain routing — CNAME → branded portal with no MogulForge chrome
- Per-org branding: logo, accent color, OG images
- Marketing routes blocked on custom domains (allow-list pattern)
- Portal tab icon served from cached per-org favicon

---

## [0.3.0] — 2026-02

### Added — Multi-Tenant Platform
- Organizations, users, roles, memberships
- Entitlements and feature gating
- Platform admin console at `/admin`
- Client invite flow
- Audit logging
- Usage metering

---

## [0.2.0] — 2026-01

### Added — AI Visibility / MogulScore™
- Public scan form with AI-powered business visibility report
- Lead capture before full report delivery
- Weekly lead digest email
- PDF report generation and attachment

### Added
- Bot trap on public scan form (silent failure for automated submissions)

---

## [0.1.0] — 2025-12

### Added — Initial Release
- Next.js 16 App Router foundation
- Marketing website (home, about, services, Revenue Rescue landing)
- OpenAI integration (server-side only)
- Basic Revenue Rescue scan endpoint
