# MogulForge

## Overview
Marketing website for MogulForge with an "AI Revenue Rescue" scan feature. Built with Next.js 16 (App Router), React 19, Tailwind CSS. Code pulled from GitHub `diazdestination/MogulForge`, branch `agent/build-mogulforge-website`.

## How to run
- Workflow "Start application" runs `npm run dev -- -H 0.0.0.0 -p 5000` (Next.js dev server on port 5000).
- `next.config.ts` includes `allowedDevOrigins` for Replit's proxied preview.

## Structure
- `app/` — pages (home, about, contact, services, revenue-rescue, ai-visibility) and API routes under `app/api/`
- Revenue Rescue public surface: `/revenue-rescue` (landing: hero, problem, how-it-works, pricing, FAQ), `/revenue-rescue/scan` (the original AI quick-scan form), `/revenue-rescue/calculator`, `/revenue-rescue/demo` (read-only dashboard from labeled demo data), `/revenue-rescue/install`, `/revenue-rescue/integrations`
- `lib/rescue-config.ts` — hardcoded pricing plans, example metrics, and calculator defaults (becomes admin-editable with the subscriptions task)
- `lib/rescue-demo-data.ts` — fictional 40-lead demo dataset powering `/revenue-rescue/demo`; aggregates are computed from the dataset so they always match
- `/revenue-rescue/start` — 7-step client intake wizard (company, lead sources, file upload, column mapping, campaign prefs, confirmations, review); requires login, creates a self-serve starter org (or reuses the user's managed org) via `lib/rescue-intake.ts`
- `components/`, `lib/` — UI components and helpers (`lib/openai.ts`)
- `worker/` — Cloudflare worker entry (used for Cloudflare hosting, not needed on Replit)


## Multi-tenant platform (Revenue Rescue SaaS)
- Postgres schema in `scripts/db/001_tenant_foundation.sql` (idempotent; apply with psql): users, organizations, memberships, entitlements, org_invites, audit_logs.
- Auth: signed-cookie sessions (`mf_session`, HMAC via SESSION_SECRET) in `lib/auth.ts`; scrypt password hashing in `lib/passwords.ts`; register/login/accept-invite logic in `lib/accounts.ts`. Pages: `/login`, `/signup`, `/account`, `/invite/[token]`.
- Authorization: `lib/api-guard.ts` (`requireUser`, `requireMember`, `requireEntitlement`, `requirePlatformAdmin`, `guard` wrapper) — membership/role/entitlement checks are server-side on every API route; org ids in URLs are never trusted.
- Tenant data layer: `lib/tenant.ts` — every query takes an organizationId. Roles in `lib/roles.ts`, feature keys in `lib/entitlements.ts`, plan presets in `lib/plans.ts`.
- Admin portal (platform admins): `/admin/organizations` (list/detail), `/admin/provision-client`, install-kit page, `/admin/audit-logs`, `/admin/login`. Legacy ADMIN_PASSWORD cookie is folded in as platform admin (`isPlatformAdmin` in `lib/admin-auth.ts`); users can also hold `users.platform_role`.
- Audit logging via `lib/audit.ts` (`logAudit`).
- Tests: `npm test` runs `tests/*.test.mjs` (tenant isolation, import unit tests, import pipeline e2e) over live HTTP against the dev server on port 5000 (needs the workflow running, DATABASE_URL, ADMIN_PASSWORD). Unit tests import `.ts` lib modules directly (Node 22 type stripping; relative imports inside `lib/rescue-import` use explicit `.ts` extensions, enabled by `allowImportingTsExtensions`).


## Lead import pipeline (Revenue Rescue)
- Schema in `scripts/db/002_revenue_rescue_imports.sql` (idempotent): rescue_intakes, lead_imports (raw file bytes in a private bytea column — never publicly served), rescue_leads (all contact/project/consent/suppression fields, org-scoped), suppression_records, import_rejected_rows.
- `lib/rescue-import/` — pure modules (fields, csv with formula-injection escaping, normalize for phone/email/date/money/consent, mapping auto-match with confidence, parse-upload for csv/xlsx/xls/json) plus server-only `store.ts` and `pipeline.ts` (staged run: validating → cleaning → deduplicating → suppression_checking → importing → complete/partial/failed; in-process, non-blocking, atomic claim prevents double runs; retry clears prior results first).
- Dedupe priority: external record id > normalized email > normalized phone (in-file, then vs existing org leads). Opt-out rows are imported suppressed and added to suppression_records; rows matching the suppression list import as suppressed.
- APIs: `/api/revenue-rescue/template` (sample CSV), `/api/revenue-rescue/intake` (+`/preview`), `/api/orgs/[orgId]/imports` (list/upload), `/[importId]` (detail, polled), `/mapping`, `/retry`, `/rejected` (escaped CSV export). Writes need `IMPORT_WRITE_ROLES` + `lead_import` entitlement.
- Dashboard: `/dashboard/revenue-rescue/imports` (org switcher, status/progress, counts, stage log, retry, rejected-row download, new-import upload + mapping). Limits: 8 MB, 20k rows. `xlsx` package installed from the SheetJS CDN tarball (npm 0.18.5 is vulnerable — don't downgrade).

## AI lead scoring & message generation (Revenue Rescue)
- Schema in `scripts/db/003_revenue_rescue_analysis.sql` (idempotent): analysis columns on rescue_leads (analysis_status/score/category/needs_review/analysis jsonb), lead_analysis_runs (batch progress), lead_message_drafts.
- `lib/rescue-analysis/` — pure modules (categories, signals = deterministic engine with per-signal explanations, ai-schema = zod-validated structured output, merge = suppression-precedence rules, message-content = draft schemas + fact sheet + template fallbacks) plus server-only `store.ts`, `engine.ts` (batch runner: batches of 4, AI retried once, deterministic-only fallback), `messages.ts` (draft generation, strict no-fabrication prompt, template fallback).
- Run control: one active run per org enforced atomically by a partial unique index (`lead_analysis_runs_one_active_idx`, INSERT ... ON CONFLICT — concurrent starts can't both win); at run start, stale 'running' runs (no progress for 10 min) are reaped to failed and leads stranded in 'analyzing' are reclaimed to 'pending', so crashes/restarts never permanently strand a lead.
- Hybrid scoring: deterministic signals (validity, recency, value, prior estimate, consent, service area from latest intake) always run; AI adds score/category/intent/reason-stalled/channel/action/angle/summary/confidence/risk flags. Final score = average; low confidence, big disagreement, or AI claiming do-not-contact without stored records → needs_manual_review. Suppressed/opted-out leads score 0 do_not_contact, never reach the model, and refuse message generation (403).
- Categories: hot_opportunity, worth_reengaging, long_term_nurture, needs_manual_review, invalid_duplicate, do_not_contact, previously_lost, existing_customer, no_longer_qualified (lifecycle ones also keyword-detected from status/notes).
- APIs (entitlement `ai_analysis` unless noted): `/api/orgs/[orgId]/analysis` (GET runs, POST start — optional importId), `/analysis/[runId]` (poll), `/leads` (GET list w/ filters, entitlement lead_import), `/leads/[leadId]` (detail + analysis explanation + drafts, lead_import), `/leads/[leadId]/messages` (GET drafts, POST generate sms|email|call_script|voicemail|follow_up_note|sequence with tone/objective/opt-out flag; roles MESSAGE_WRITE_ROLES). Drafts are stored, never sent (campaigns task owns sending).
- Import hand-off: pipeline auto-starts an analysis run after a successful import when the org has `ai_analysis`; logged as an "analyzing" stage-log entry, run exposed as `analysisRun` on the import detail API.

## Client dashboard, campaigns & appointments (Revenue Rescue)
- Schema in `scripts/db/004_revenue_rescue_engagement.sql` (idempotent): pipeline columns on rescue_leads (assigned_user_id, pipeline_stage, won_value), rescue_campaigns, rescue_campaign_leads, rescue_messages (DB CHECK `rescue_messages_simulation_honesty` — a simulated outbound message can never carry a real delivery status), rescue_appointments, rescue_activities, rescue_tasks.
- `lib/rescue-engage/` — pure modules (pipeline stages, campaign-schema — opt_out stop condition always forced, campaign-templates = the 8 spec templates, providers = honest not-connected SMS/email status, calendar-adapters = manual-only + honest external stubs, replies = 12-category rule-based classifier where opt_out/complaint/sensitive always win) plus server-only `store.ts`, `eligibility.ts` (audience accounting: suppressed → opted-out → DNC → invalid → closed → no-contact-channel → already-enrolled → eligible), `send-engine.ts` (activation requires `confirm:true`; live mode refused with no provider — never silently downgraded; simulated sends re-check suppression at send time), `reply-service.ts` (classify → suppress/stop/task/escalate/stage per REPLY_ROUTING), `metrics.ts` (overview: cards/funnel/hot leads/campaign perf/revenue-over-time/activity; rep-scoped via assignedUserId).
- Reply safety rules: opt-out suppresses immediately + unconditionally (consent → opted_out, suppression_records written, all campaigns stopped); complaint/sensitive stop ALL automation and create escalation tasks.
- Dashboard pages under `/dashboard/revenue-rescue` (layout with sub-nav preserving `?org=`): overview, `leads` (search/filters/sort/pagination/bulk assign-stage-suppress-add-to-campaign), `leads/[leadId]` (score explanation, drafts, conversation thread + manual outbound log + reply recording, appointments, tasks, timeline), `campaigns` (+ `[campaignId]` with preview accounting + explicit activation confirmation; Simulation Mode labeled everywhere), `conversations`, `appointments` (manual booking; adapter statuses). Org resolution shared in `lib/dashboard-context.ts`.
- APIs under `/api/orgs/[orgId]/`: overview, conversations, tasks/[taskId], campaigns (+[campaignId], /preview, /activate), appointments (+[appointmentId]), leads (rewritten w/ filters), leads/[leadId] (+PATCH actions, /replies, /thread), leads/actions (bulk, max 200). Sales reps are server-side restricted to assigned leads; write roles per lib/roles.ts arrays.
- Tests: `tests/rescue-engage-unit.test.mjs` (classifier/routing/schema/provider honesty) and `tests/rescue-engagement.test.mjs` (eligibility, simulation protection incl. DB constraint, reply routing, role access, manual booking).

## Environment
- `OPENAI_API_KEY` required for the Revenue Rescue scan API; `OPENAI_MODEL` optional.
- `DATABASE_URL` (Postgres), `SESSION_SECRET` (cookie signing), `ADMIN_PASSWORD` (platform-admin password login).
- Weekly lead digest: `RESEND_API_KEY` + `LEAD_DIGEST_TO` (recipient) required; `LEAD_DIGEST_FROM` optional (defaults to `onboarding@resend.dev` until the domain is verified in Resend); `CRON_SECRET` optional bearer token for triggering `POST /api/cron/lead-digest` externally. An hourly in-app check (`instrumentation.ts`) sends the digest at most once a week and only when there are new leads.


## User preferences
(none recorded yet)
