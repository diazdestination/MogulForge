# MogulForge

Production-ready Next.js website for MogulForge, centered on the flagship **AI Revenue Rescue™** offer and supporting **MogulScore™** diagnostic.

## Local setup

1. Install dependencies with `npm install`.
2. Start the site with `npm run dev`.
3. Open `http://localhost:3000`.

The private OpenAI key is stored locally at `.env.local` as `OPENAI_API_KEY`. This file is intentionally ignored by Git and must never be committed. If you forget where the key lives, this is the reminder.

For Replit, add `OPENAI_API_KEY` and optional `OPENAI_MODEL` through Replit Secrets. Use `.env.example` as the non-secret configuration reference.

## Quality checks

- `npm run typecheck`
- `npm run lint`
- `npm run build`

## Architecture

- App Router pages in `app/`
- Shared navigation and calls-to-action in `components/`
- Validated Revenue Rescue input schema in `lib/rescue-schema.ts`
- Server-only OpenAI client in `lib/openai.ts`
- Responses API endpoint in `app/api/revenue-rescue/route.ts`

The API key never reaches the browser. The client submits validated business inputs to the server route, which calls the OpenAI Responses API and returns the analysis.
