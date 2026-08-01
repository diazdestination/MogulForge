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
- "Start a Sprint" CTAs point to `/contact` until the `/revenue-rescue/start` intake wizard ships (separate task)
- `components/`, `lib/` — UI components and helpers (`lib/openai.ts`)
- `worker/` — Cloudflare worker entry (used for Cloudflare hosting, not needed on Replit)


## Multi-tenant platform (Revenue Rescue SaaS)
- Postgres schema in `scripts/db/001_tenant_foundation.sql` (idempotent; apply with psql): users, organizations, memberships, entitlements, org_invites, audit_logs.
- Auth: signed-cookie sessions (`mf_session`, HMAC via SESSION_SECRET) in `lib/auth.ts`; scrypt password hashing in `lib/passwords.ts`; register/login/accept-invite logic in `lib/accounts.ts`. Pages: `/login`, `/signup`, `/account`, `/invite/[token]`.
- Authorization: `lib/api-guard.ts` (`requireUser`, `requireMember`, `requireEntitlement`, `requirePlatformAdmin`, `guard` wrapper) — membership/role/entitlement checks are server-side on every API route; org ids in URLs are never trusted.
- Tenant data layer: `lib/tenant.ts` — every query takes an organizationId. Roles in `lib/roles.ts`, feature keys in `lib/entitlements.ts`, plan presets in `lib/plans.ts`.
- Admin portal (platform admins): `/admin/organizations` (list/detail), `/admin/provision-client`, install-kit page, `/admin/audit-logs`, `/admin/login`. Legacy ADMIN_PASSWORD cookie is folded in as platform admin (`isPlatformAdmin` in `lib/admin-auth.ts`); users can also hold `users.platform_role`.
- Audit logging via `lib/audit.ts` (`logAudit`).
- Tests: `npm test` runs `tests/tenant-isolation.test.mjs` over live HTTP against the dev server on port 5000 (needs the workflow running, DATABASE_URL, ADMIN_PASSWORD).

## Environment
- `OPENAI_API_KEY` required for the Revenue Rescue scan API; `OPENAI_MODEL` optional.
- `DATABASE_URL` (Postgres), `SESSION_SECRET` (cookie signing), `ADMIN_PASSWORD` (platform-admin password login).

## User preferences
(none recorded yet)
