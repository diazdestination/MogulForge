# MogulForge GrowthOS

> **The white-label AI revenue platform for growth agencies.**  
> Find lost revenue, re-engage cold leads, and close more jobs — without extra ad spend.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-16-black)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB)](https://react.dev/)
[![License](https://img.shields.io/badge/license-Proprietary-red)](#license)

---

## What is MogulForge GrowthOS?

MogulForge GrowthOS is a **multi-tenant SaaS platform** built for agencies and operators who manage revenue growth for home-service and trades businesses. It combines:

| Product | What it does |
|---|---|
| **AI Revenue Rescue™** | Scores and re-engages stale estimates, no-shows, and uncontacted leads via AI-written SMS/email campaigns |
| **Discovery Engine** | Surfaces organic revenue opportunities from Google Business Profile, search analytics, site crawl signals, and your CRM pipeline |
| **MogulScore™ / AI Visibility** | Diagnoses how visible a business is to AI assistants and search engines; captures scan leads |
| **White-Label Portal** | Each client gets a branded subdomain or custom domain with their logo, colors, and domain-safe transactional emails |

---

## Feature Overview

### Core Platform
- Multi-tenant architecture with organizations, roles (`owner`, `manager`, `member`), and entitlements
- Custom domain routing — client portals served live on verified `CNAME`-pointed domains
- White-label branding: per-org logo, accent colors, portal chrome, and OG images
- Usage metering, plan definitions, and Stripe-backed subscription management
- Platform admin console at `/admin` (audit logs, org management, support tools)
- Secure signed-cookie sessions with scrypt password hashing

### Revenue Rescue™
- CSV / XLSX / JSON lead import with auto-column mapping and formula-injection escaping
- AI lead scoring (GPT-4o-mini) with deterministic fallback — never silently skips a lead
- Campaign builder: multi-step SMS + email sequences with AI-drafted messages
- Quiet-hours enforcement by business time zone
- Opt-out / suppression list management (STOP texts, email bounces, manual suppress)
- CRM sync: HubSpot and GoHighLevel — bidirectional push with retry queue
- Calendar sync: Google Calendar, Outlook, and Calendly booking links with per-org OAuth
- Closer briefings: on-demand GPT-4o-mini analysis cached per lead

### Discovery Engine
- Four signal adapters: stale estimates, hot uncontacted leads, site pages missing a CTA, Search Console low-CTR queries
- Google Business Profile unanswered review surfacing (requires `business.manage` OAuth scope)
- Opportunity cards with act / dismiss workflow
- Organic wins tracker: closed leads that came in without paid ads
- Scheduled cron at `POST /api/cron/discovery` (CRON_SECRET bearer)

### Security & Operations
- Bot trap on the public scan form with spike-level alerting
- Stale-scheduler detection — email alert if the cron goes quiet
- Advisory-lock concurrency control (no double-processing across multiple servers)
- Full audit log on every sensitive write
- SSRF guard on tenant-provided logo URLs (DNS-vetting + IP-pinning, no redirects)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Next.js 16 (App Router)                  │
│  app/                  pages + API routes (RSC + Route Handlers) │
│  components/           client components                         │
│  lib/                  server-only business logic                │
│  instrumentation.ts    background scheduler (in-process)         │
└──────────────────────┬──────────────────────────────────────────┘
                       │
          ┌────────────┼────────────────┐
          ▼            ▼                ▼
     PostgreSQL     OpenAI          Resend / Twilio
   (single DB,    (GPT-4o-mini     (transactional email
    row-level      scoring,         + SMS outreach)
    org isolation) drafts,
                   briefings)
          │
   ┌──────┴──────────────────┐
   │  Stripe  │  HubSpot/GHL  │  Google / Outlook / Calendly
   └──────────────────────────┘
```

**Stack:**
- **Framework:** Next.js 16 (App Router, Turbopack in dev)
- **Language:** TypeScript 5.9 (strict)
- **Database:** PostgreSQL 15+ via `pg` (connection pool, no ORM)
- **AI:** OpenAI Node SDK v5 — GPT-4o-mini for all inference
- **Email:** Resend (transactional) — separate key for outreach vs. platform alerts
- **SMS:** Twilio Messaging Service
- **Payments:** Stripe (subscription lifecycle)
- **Styling:** Tailwind CSS v3 + inline styles for per-org accent colors
- **Testing:** Node.js built-in test runner (`node:test`) — no Jest, no Vitest

---

## Quick Start

### Prerequisites
- Node.js 22+
- PostgreSQL 15+ (local or hosted)
- An OpenAI API key

### 1 — Clone and install

```bash
git clone https://github.com/diazdestination/MogulForge.git
cd MogulForge
npm install
```

### 2 — Configure environment

```bash
cp .env.example .env.local
# Fill in the required values — see Environment Variables below
```

### 3 — Apply database migrations

```bash
# Apply all migration scripts in order (they are idempotent — safe to re-run)
for f in scripts/db/*.sql; do psql "$DATABASE_URL" -f "$f"; done
```

### 4 — Start the dev server

```bash
npm run dev
# → http://localhost:5000
```

The platform admin console is at `/admin`. Log in with your `ADMIN_PASSWORD`.

---

## Environment Variables

Copy `.env.example` and fill in the values. All variables marked **required** must be set before the server will start correctly.

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string (`postgresql://user:pass@host:5432/db`) |
| `SESSION_SECRET` | ✅ | 32+ character random string for signing session cookies |
| `ADMIN_PASSWORD` | ✅ | Platform admin login password (console at `/admin`) |
| `OPENAI_API_KEY` | ✅ | OpenAI API key for lead scoring, drafts, and briefings |
| `CRON_SECRET` | ✅ | Bearer token for scheduler cron routes |
| `RESEND_API_KEY` | ✅ | Resend API key for platform transactional emails |
| `OPENAI_MODEL` | — | Override the OpenAI model (default: `gpt-4o-mini`) |
| `NEXT_PUBLIC_SITE_URL` | — | Canonical public URL (used in OG tags and email links) |
| `PUBLIC_BASE_URL` | — | Server-side base URL for absolute links in emails |
| `LEAD_DIGEST_TO` | — | Email address that receives new-lead digest emails |
| `LEAD_DIGEST_FROM` | — | Sender address for lead digest emails |
| `LEAD_DIGEST_REPLY_TO` | — | Reply-to address for lead digest emails |
| `ORG_ALERTS_FROM` | — | Sender address for per-org alert emails (CRM outage, domain break, etc.) |
| `OUTREACH_RESEND_API_KEY` | — | **Separate** Resend key for campaign outreach emails (never share with digest key) |
| `OUTREACH_EMAIL_FROM` | — | Sender address for campaign outreach emails |
| `RESEND_WEBHOOK_SECRET` | — | Resend webhook signing secret (for bounce/complaint handling) |
| `TWILIO_ACCOUNT_SID` | — | Twilio account SID (SMS campaigns) |
| `TWILIO_AUTH_TOKEN` | — | Twilio auth token |
| `TWILIO_MESSAGING_SERVICE_SID` | — | Twilio messaging service SID |
| `TWILIO_PHONE_NUMBER` | — | Fallback Twilio phone number |
| `CUSTOM_DOMAIN_CNAME_TARGET` | — | The CNAME target clients point their domain at (e.g. `portals.mogulforge.com`) |
| `BILLING_PROVIDER` | — | `stripe` or leave unset to disable billing |
| `PUBLIC_API_RATE_LIMIT` | — | Requests-per-minute for the public API (default: 60) |
| `RR_API_KEY` | — | Static bearer token for the Revenue Rescue public API |

> **Security note:** Never commit `.env.local` to version control. The `.env.example` file contains only placeholder values and is safe to commit.

---

## Database Setup

All schema files live in `scripts/db/` and are **idempotent** — safe to re-run at any time.

```bash
# Apply all migrations
for f in $(ls scripts/db/*.sql | sort); do
  echo "Applying $f..."
  psql "$DATABASE_URL" -f "$f"
done
```

### Migration files

| File | What it creates |
|---|---|
| `001_tenant_foundation.sql` | users, organizations, memberships, entitlements, org_invites, audit_logs |
| `002_revenue_rescue_imports.sql` | rescue_intakes, lead_imports, rescue_leads, suppression_records, import_rejected_rows |
| `003_revenue_rescue_analysis.sql` | AI scoring columns on rescue_leads, lead_analysis_runs, lead_message_drafts |
| `004_revenue_rescue_engagement.sql` | campaign engagement tracking |
| `005_org_settings.sql` | per-org notification and CRM settings |
| `005_public_api_webhooks_embeds.sql` | webhook endpoints and embed tokens |
| `006_usage_plans_branding.sql` | plan_definitions, usage_events, org_branding |
| `007_embed_theme.sql` | embed theme customization |
| `007_lead_status.sql` | lead pipeline status fields |
| `007_visibility_reports.sql` | AI Visibility / MogulScore reports |
| `008_crm_push_deliveries.sql` | HubSpot/GHL push retry queue |
| `008_cron_heartbeat.sql` | scheduler heartbeat tracking |
| `008_pending_plan_change.sql` | pending plan change state |
| `009_org_calendar_connections.sql` | per-org OAuth calendar connections |
| `009_plan_change_reminder.sql` | plan-change retry state |
| `010_crm_push_retry.sql` | enhanced CRM retry with backoff |
| `010_rate_limit_windows.sql` | sliding-window rate limits |
| `011_org_onboarding.sql` | onboarding wizard state |
| `011_pending_plan_failure_alert.sql` | plan failure alert state |
| `012_bot_trap_hits.sql` | bot trap submission log |
| `012_org_calendar_connection_status.sql` | calendar connection health |
| `012_site_health.sql` | site crawl and health records |
| `013_bot_trap_alert_state.sql` | bot trap spike alert state |
| `013_discovery_opportunities.sql` | org_discovery_runs, org_opportunities, lead_closer_briefings |
| `014_campaign_link_clicks.sql` | booking link click tracking |

---

## Development Commands

```bash
npm run dev          # Start Next.js dev server (Turbopack) on port 5000
npm run build        # Production build
npm run start        # Start production server
npm run typecheck    # TypeScript type check (no emit)
npm run lint         # ESLint
npm run test         # Run all tests (requires dev server running on port 5000)
```

### Running a single test file

```bash
# IMPORTANT: never run npm test against a cold server — it spawns parallel
# requests that can saturate the DB pool. Run files one at a time:
node --test tests/tenant-isolation.test.mjs
node --test tests/rescue-import.test.mjs
```

---

## Deployment

MogulForge is designed to run on any Node.js 22+ host with a PostgreSQL database.

### Replit (current)
The project runs on Replit with the workflow command:
```
npm run dev -- -H 0.0.0.0 -p 5000
```
For production on Replit, use **Replit Deployments** (Autoscale). Set all environment variables in Replit Secrets before deploying.

### Custom host (Vercel, Railway, Render, etc.)
1. Set all required environment variables on your host
2. Run `npm run build` then `npm run start`
3. Point your DNS CNAME for client portals to `CUSTOM_DOMAIN_CNAME_TARGET`
4. Apply migrations against your production database

### Scheduler (cron)
The in-process scheduler fires automatically when the server is warm. For autoscale deployments where the server may be cold, configure an external cron to hit these endpoints with `Authorization: Bearer $CRON_SECRET`:

| Schedule | Endpoint |
|---|---|
| Every 5 min | `POST /api/cron/heartbeat` |
| Every 15 min | `POST /api/cron/crm-pull` |
| Every hour | `POST /api/cron/discovery` |
| Daily | `POST /api/cron/log-cleanup` |

---

## White-Label Configuration

Each organization can be configured with:

- **Custom domain** — point a client's `CNAME` to `CUSTOM_DOMAIN_CNAME_TARGET`; the middleware detects the host and serves the branded portal automatically
- **Logo** — served from a validated URL; the portal tab icon is cached to avoid refetching
- **Accent color** — applied via inline styles (Tailwind utilities are static at build time)
- **Sender domain** — once Resend verifies the client's domain, transactional emails send from their own address
- **Portal chrome** — marketing navigation and MogulForge branding are stripped on custom domains

To provision a new white-label client:
1. Create the org at `/admin/provision-client`
2. Set entitlements (e.g., `revenue_rescue`) from the org detail page
3. Send the invite link to the client owner
4. The client completes the intake wizard at `/revenue-rescue/start`

---

## Client Onboarding Process

```
Admin creates org + invite
         ↓
Client accepts invite → sets password
         ↓
Intake wizard (7 steps):
  1. Company details & time zone
  2. Lead sources selection
  3. CSV/XLSX lead file upload
  4. Column mapping (auto-matched)
  5. Campaign preferences (quiet hours, opt-out wording)
  6. CRM connection (HubSpot / GoHighLevel)
  7. Review & launch
         ↓
AI scoring runs on imported leads
         ↓
First campaign activated → AI drafts messages
         ↓
Client views dashboard: leads, campaigns, reports, opportunities
```

---

## Security

See [SECURITY.md](SECURITY.md) for the full vulnerability disclosure policy.

Key practices:
- All API routes enforce authentication and authorization server-side — org IDs in URLs are never trusted
- Session secrets must be 32+ characters of random entropy
- Tenant-provided logo URLs are SSRF-guarded (DNS-vetted, IP-pinned, no redirects)
- The OpenAI API key never reaches the browser
- Bot trap on the public scan form with silent failure for automated submissions
- Advisory locks prevent concurrent processing across multiple server instances

---

## Repository Structure

```
MogulForge/
├── app/                         # Next.js App Router
│   ├── (marketing)/             # Public marketing pages
│   ├── admin/                   # Platform admin console
│   ├── api/                     # API route handlers
│   │   ├── admin/               # Admin-only APIs
│   │   ├── cron/                # Scheduler endpoints
│   │   ├── orgs/[orgId]/        # Tenant APIs (auth required)
│   │   └── revenue-rescue/      # Public scan API
│   ├── dashboard/               # Client dashboard
│   │   └── revenue-rescue/      # Revenue Rescue module
│   └── embed/                   # Embeddable widget pages
├── components/                  # Shared React components
├── lib/                         # Server-side business logic
│   ├── auth.ts                  # Session management
│   ├── tenant.ts                # Multi-tenant data layer
│   ├── rescue-analysis/         # AI scoring engine
│   ├── rescue-import/           # Lead import pipeline
│   ├── discovery/               # Discovery engine + signal adapters
│   ├── calendar/                # Calendar OAuth + sync
│   └── crm/                     # HubSpot / GHL connectors
├── scripts/db/                  # Idempotent SQL migrations (001–014)
├── tests/                       # Integration tests (node:test)
├── worker/                      # Cloudflare Worker entry (optional)
├── .env.example                 # Environment variable template
├── CHANGELOG.md
├── CONTRIBUTING.md
├── ROADMAP.md
└── SECURITY.md
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

---

## License

Proprietary. All rights reserved. © Diaz Destination LLC.  
This software is not open source. Do not distribute without authorization.
