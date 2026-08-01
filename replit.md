# MogulForge

## Overview
Marketing website for MogulForge with an "AI Revenue Rescue" scan feature. Built with Next.js 16 (App Router), React 19, Tailwind CSS. Code pulled from GitHub `diazdestination/MogulForge`, branch `agent/build-mogulforge-website`.

## How to run
- Workflow "Start application" runs `npm run dev -- -H 0.0.0.0 -p 5000` (Next.js dev server on port 5000).
- `next.config.ts` includes `allowedDevOrigins` for Replit's proxied preview.

## Structure
- `app/` — pages (home, about, contact, services, revenue-rescue) and API route `app/api/revenue-rescue/route.ts`
- Revenue Rescue public surface: `/revenue-rescue` (landing: hero, problem, how-it-works, pricing, FAQ), `/revenue-rescue/scan` (the original AI quick-scan form), `/revenue-rescue/calculator`, `/revenue-rescue/demo` (read-only dashboard from labeled demo data), `/revenue-rescue/install`, `/revenue-rescue/integrations`
- `lib/rescue-config.ts` — hardcoded pricing plans, example metrics, and calculator defaults (becomes admin-editable with the subscriptions task)
- `lib/rescue-demo-data.ts` — fictional 40-lead demo dataset powering `/revenue-rescue/demo`; aggregates are computed from the dataset so they always match
- "Start a Sprint" CTAs point to `/contact` until the `/revenue-rescue/start` intake wizard ships (separate task)
- `components/`, `lib/` — UI components and helpers (`lib/openai.ts`)
- `worker/` — Cloudflare worker entry (used for Cloudflare hosting, not needed on Replit)

## Environment
- `OPENAI_API_KEY` required for the Revenue Rescue scan API; `OPENAI_MODEL` optional.

## User preferences
(none recorded yet)
