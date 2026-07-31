# MogulForge

## Overview
Marketing website for MogulForge with an "AI Revenue Rescue" scan feature. Built with Next.js 16 (App Router), React 19, Tailwind CSS. Code pulled from GitHub `diazdestination/MogulForge`, branch `agent/build-mogulforge-website`.

## How to run
- Workflow "Start application" runs `npm run dev -- -H 0.0.0.0 -p 5000` (Next.js dev server on port 5000).
- `next.config.ts` includes `allowedDevOrigins` for Replit's proxied preview.

## Structure
- `app/` — pages (home, about, contact, services, revenue-rescue) and API route `app/api/revenue-rescue/route.ts`
- `components/`, `lib/` — UI components and helpers (`lib/openai.ts`)
- `worker/` — Cloudflare worker entry (used for Cloudflare hosting, not needed on Replit)

## Environment
- `OPENAI_API_KEY` required for the Revenue Rescue scan API; `OPENAI_MODEL` optional.

## User preferences
(none recorded yet)
