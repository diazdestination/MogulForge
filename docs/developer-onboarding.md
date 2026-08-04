# Developer Onboarding — MogulForge GrowthOS

Welcome. This document is the fast path from zero to productive contributor.  
Read this before reading anything else.

---

## Mental Model

MogulForge is a **multi-tenant B2B SaaS platform**. The three most important things to internalize:

1. **Every piece of data belongs to an org.** There is no global user data. Every query against tenant data must be scoped by `organizationId`. If you write a query that fetches a lead by primary key without also checking `organization_id`, you've written a multi-tenant isolation bug.

2. **The server enforces auth. URLs are untrusted.** An org ID in a URL is a hint, not a proof. `lib/api-guard.ts` enforces that the caller is actually a member of that org on every request. Never skip this.

3. **AI paths must have a fallback.** Every feature that calls OpenAI must degrade gracefully when the model is slow, down, or rate-limited. The deterministic scoring engine in `lib/rescue-analysis/` is the model for how to do this.

---

## First 30 Minutes

```bash
# 1. Install
git clone https://github.com/diazdestination/MogulForge.git && cd MogulForge
npm install

# 2. Configure
cp .env.example .env.local
# Fill in: DATABASE_URL, SESSION_SECRET, ADMIN_PASSWORD, OPENAI_API_KEY, CRON_SECRET, RESEND_API_KEY

# 3. Apply schema
for f in $(ls scripts/db/*.sql | sort); do psql "$DATABASE_URL" -f "$f"; done

# 4. Start
npm run dev  # → http://localhost:5000

# 5. Open admin console
# → http://localhost:5000/admin
# → log in with ADMIN_PASSWORD
```

If you can log into the admin console and see the organization list, you're up.

---

## Key Files to Read First

Don't try to read the whole codebase. Read these five files and you'll understand 80% of how the platform works:

| File | What it teaches you |
|---|---|
| `lib/api-guard.ts` | How auth and authorization work on every route |
| `lib/tenant.ts` | The multi-tenant data layer — every org query goes through here |
| `lib/auth.ts` | Session management (cookie signing, HMAC) |
| `lib/entitlements.ts` | Feature keys and how entitlement gates work |
| `instrumentation.ts` | The in-process background scheduler |

---

## How the App is Organized

```
app/                     Next.js App Router
  (marketing)/           Public pages — no auth required
  admin/                 Platform admin — requires ADMIN_PASSWORD or platform_role
  api/
    admin/               Admin-only API routes
    cron/                Scheduler endpoints — CRON_SECRET bearer token
    orgs/[orgId]/        All tenant APIs — requireMember or higher
    revenue-rescue/      Public scan API — rate limited
  dashboard/
    revenue-rescue/      Client-facing Revenue Rescue dashboard
  embed/                 Embeddable widget pages

lib/                     Server-side logic only
  rescue-analysis/       AI scoring engine (pure modules + server-only store/engine)
  rescue-import/         Lead import pipeline
  discovery/             Discovery engine + signal adapters
  calendar/              Per-org OAuth, Google/Outlook/Calendly sync
  crm/                   HubSpot, GoHighLevel connectors

scripts/db/              Idempotent SQL migrations (001–014)
tests/                   Integration tests (node:test)
```

---

## Auth Flow

```
POST /api/admin/session     →  sets admin cookie  →  /admin routes
POST /signup                →  creates user       →  sets session cookie
POST /login                 →  authenticates      →  sets session cookie
GET  /invite/[token]        →  accept invite      →  creates membership
```

Session cookie: `mf_session` — HMAC-signed JSON, `HttpOnly`, `SameSite=Lax`.

### How requireMember works

```typescript
// Every tenant API route starts like this:
export const GET = guard(async (req, { params }) => {
  const { org, user } = await requireMember(req, params.orgId);
  // org and user are now verified and typed
  // org.id is the real org — params.orgId was just a hint
});
```

If the user is not a member of the org, `requireMember` throws a 403 before your handler runs.

---

## Database Conventions

- Raw SQL via `pg` connection pool. No ORM.
- Always parameterized queries — `$1, $2, ...` — never string interpolation.
- Every tenant table has an `organization_id` column. Every query scopes by it.
- Migration files are named `NNN_description.sql` and are idempotent (`IF NOT EXISTS`, `IF NOT EXISTS` on columns, etc.).

```typescript
// ✅ Correct — scoped by org
const { rows } = await getPool().query(
  'SELECT * FROM rescue_leads WHERE organization_id = $1 AND id = $2',
  [orgId, leadId]
);

// ❌ Wrong — no org scope
const { rows } = await getPool().query(
  'SELECT * FROM rescue_leads WHERE id = $1',
  [leadId]
);
```

---

## Admin Provisioning API Shape

When writing scripts or tests that provision orgs:

```typescript
// Create org
const res = await fetch('/api/admin/organizations', {
  method: 'POST',
  body: JSON.stringify({
    name: 'Acme Roofing',
    owner: { email: 'owner@acme.com' },   // nested under owner, not ownerEmail
    modules: ['revenue_rescue'],
  }),
});
const { organizationId, inviteToken } = await res.json();
// NOT organization.id / inviteCode — those are the wrong field names

// Accept invite
await fetch('/api/invites/accept', {
  method: 'POST',
  body: JSON.stringify({
    code: inviteToken,                     // field name is "code", value is inviteToken
    name: 'Owner Name',
    email: 'owner@acme.com',
    password: 'SecurePass1!',
  }),
});
```

---

## Testing

```bash
# Run a single test file (always do this first)
node --test tests/tenant-isolation.test.mjs

# Run all tests (only when the dev server has been warm for a few minutes)
npm test
```

**Critical:** Never run `npm test` (all files in parallel) against a cold server. The parallel DB connections saturate the pool and hang the server. Run one file at a time.

HTTP tests must use `http://localhost:5000` — not `$REPLIT_DEV_DOMAIN`, which resolves to a private IP inside the container.

---

## Environment Variables

See `.env.example` for the full list with descriptions.

Minimum for local dev:
```
DATABASE_URL
SESSION_SECRET
ADMIN_PASSWORD
OPENAI_API_KEY
CRON_SECRET
RESEND_API_KEY
```

---

## Common Pitfalls

| Pitfall | What goes wrong | Fix |
|---|---|---|
| Using `REPLIT_DEV_DOMAIN` in server-side tests | Resolves to private IP, requests fail or SSRF-guard rejects | Use `http://localhost:5000` |
| Running all tests in parallel | DB pool saturation, server hangs | Run one test file at a time |
| Calling `markTaskInProgress` on an already-MAIN_IN_PROGRESS task | Shifts state to IN_PROGRESS (task-agent state), `markTaskComplete` stops working | Only call `markTaskInProgress` when starting a task fresh |
| Tailwind classes for dynamic colors | Classes don't exist at build time | Use inline styles for per-org accent colors |
| Missing `requireMember` on a tenant route | Cross-tenant data leak | Every route in `app/api/orgs/[orgId]/` needs the guard |
| Sharing RESEND_API_KEY for outreach | Domain reputation damage | Always use a separate `OUTREACH_RESEND_API_KEY` |
| Querying without org scope | Multi-tenant isolation bug | Always `WHERE organization_id = $1` |

---

## Getting Help

- Check `.agents/memory/MEMORY.md` for documented decisions and known quirks
- Check `ROADMAP.md` to see if a feature is planned before building it
- Open a GitHub issue with the `question` label for architectural questions
- For security issues, email security@mogulforge.com — not GitHub issues
