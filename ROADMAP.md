# MogulForge GrowthOS — Product Roadmap

This document describes the current state of the platform and the direction we're heading. It is a living document — priorities shift as we learn from clients.

---

## Phase 1 — Foundation ✅ Complete

The multi-tenant SaaS skeleton everything else is built on.

- [x] Organizations, users, roles, memberships
- [x] Entitlements and plan definitions
- [x] Signed-cookie sessions with scrypt password hashing
- [x] Platform admin console (`/admin`)
- [x] Client invite flow
- [x] Audit logging
- [x] Usage metering

---

## Phase 2 — Revenue Rescue Core ✅ Complete

The flagship module: find money already sitting in your client's pipeline.

- [x] CSV / XLSX / JSON lead import with auto-column mapping
- [x] AI lead scoring (GPT-4o-mini) with deterministic fallback
- [x] Campaign builder: multi-step SMS + email sequences
- [x] AI message drafting with mandatory opt-out wording
- [x] Quiet-hours enforcement by business time zone
- [x] Opt-out / suppression list management
- [x] CRM sync: HubSpot and GoHighLevel
- [x] Calendar sync: Google Calendar, Outlook, Calendly
- [x] Booking link credit tracking
- [x] Dashboard reports (booked, revenue, campaign performance)
- [x] CSV export with full lead status

---

## Phase 3 — White-Label & Infrastructure ✅ Complete

The platform layer that turns this into a sellable product.

- [x] Custom domain routing (CNAME → branded portal, no MogulForge chrome)
- [x] Per-org branding: logo, accent colors, OG images
- [x] Embed widget with per-org CSP and short-lived tokens
- [x] Public API with bearer auth and rate limiting
- [x] Webhook delivery with retry queue and backoff
- [x] Stripe-backed subscription management with self-serve upgrade/downgrade
- [x] Bot trap with spike-level alerting
- [x] Stale-scheduler detection and alert email
- [x] Advisory-lock concurrency control (multi-server safe)
- [x] Full SSRF guard on tenant-provided URLs

---

## Phase 4 — Discovery Engine ✅ Complete

Proactive opportunity surfacing — find revenue before the client even knows to look.

- [x] Stale estimate signal (leads with open estimates > 60 days)
- [x] Hot uncontacted lead signal (high AI score, never contacted)
- [x] Site crawl signal (pages missing a CTA detected by the crawler)
- [x] Search Console signal (high-impression, low-CTR queries)
- [x] Google Business Profile signal (unanswered reviews)
- [x] Opportunity card UI with act / dismiss workflow
- [x] Organic wins tracker (closed leads with no paid-ad attribution)
- [x] Closer briefing: on-demand GPT-4o-mini lead analysis cached per lead
- [x] Scheduled discovery cron

---

## Phase 5 — Reliability & Scale 🚧 In Progress

Making the platform bullet-proof as client volume grows.

- [ ] Campaign activation for 500+ leads without silent message drops (#161)
- [ ] Concurrent activation with partial AI failure handling (#162)
- [ ] +1 country-code phone deduplication in bulk CSV imports
- [ ] Calendly reschedule and cancellation event handling (#173)
- [ ] Pipeline stage changes retiring open discovery cards (#179)
- [ ] Opt-out compliance on re-suppressed leads discovered after enrollment (#155, #178)
- [ ] Stale-scheduler detection per-job (not just global silence) (#158)
- [ ] Domain health cron auth hardening (#170)
- [ ] Plan-change backoff visibility for operators (#168, #169)

---

## Phase 6 — Mobile & Self-Serve 📋 Planned

Bringing the platform to where clients actually spend their time.

- [ ] **Native mobile app (CRM Mobile)** — lead pipeline, campaign status, booking feed
- [ ] Push notifications for hot leads and booked appointments
- [ ] Mobile-first campaign approval flow
- [ ] Self-serve client onboarding without admin intervention
- [ ] In-app upgrade prompts tied to usage milestones

---

## Phase 7 — Intelligence Layer 📋 Planned

Moving from reactive (score existing leads) to predictive (tell clients what to do next).

- [ ] **Predictive close probability** — ML model trained on historical win/loss data
- [ ] **Next-best-action recommendations** — ranked list of actions per lead
- [ ] **Competitive intelligence feed** — aggregated signals from local search
- [ ] **Revenue forecast** — projected close rate × average job value
- [ ] **Automated A/B testing** for message variants

---

## Phase 8 — Enterprise & Marketplace 🔮 Future

The top of the market and the network effect that makes switching hard.

- [ ] SSO / SAML for enterprise clients
- [ ] Advanced multi-org hierarchy (franchise / enterprise accounts)
- [ ] Custom AI model fine-tuning per client vertical (HVAC, roofing, plumbing, etc.)
- [ ] Integration marketplace (Jobber, ServiceTitan, Housecall Pro, etc.)
- [ ] White-label mobile app (client's brand, client's App Store listing)
- [ ] Agency partner portal with client revenue dashboards

---

## What We're Not Building

To keep the platform focused and maintainable:

- **Replying to Google reviews** from within MogulForge (read-only for now)
- **Full CRM replacement** — we sync with HubSpot/GHL; we are not a CRM
- **Landing page builder** — use your existing site or a dedicated tool
- **Paid ad management** — we optimize the organic side; ads are out of scope

---

*Last updated: August 2026*
