# Contributing to MogulForge GrowthOS

Thank you for contributing! This document covers everything you need to get started, write good code, and get your changes merged cleanly.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Branch Workflow](#branch-workflow)
- [Development Guidelines](#development-guidelines)
- [Testing](#testing)
- [Pull Request Process](#pull-request-process)
- [Commit Message Convention](#commit-message-convention)
- [Architecture Decisions](#architecture-decisions)

---

## Code of Conduct

Be direct, constructive, and respectful. This is a professional engineering environment. Harassment, condescension, or bad-faith contributions will not be tolerated.

---

## Getting Started

1. **Fork or clone** the repository and create a feature branch (see [Branch Workflow](#branch-workflow))
2. **Install dependencies:** `npm install`
3. **Copy env template:** `cp .env.example .env.local` and fill in at minimum `DATABASE_URL`, `SESSION_SECRET`, `ADMIN_PASSWORD`, `OPENAI_API_KEY`, and `CRON_SECRET`
4. **Apply migrations:** `for f in $(ls scripts/db/*.sql | sort); do psql "$DATABASE_URL" -f "$f"; done`
5. **Start dev server:** `npm run dev`
6. **Verify the app loads:** open `http://localhost:5000`

---

## Branch Workflow

| Branch pattern | Purpose |
|---|---|
| `main` | Stable, production-ready code. Protected — no direct pushes. |
| `agent/build-*` | AI agent feature branches |
| `feature/<short-description>` | New features |
| `fix/<short-description>` | Bug fixes |
| `chore/<short-description>` | Tooling, deps, docs |

**Never push directly to `main`.** Open a PR and request a review.

### Typical workflow

```bash
git checkout main && git pull
git checkout -b feature/my-new-thing
# ... make changes ...
git add -p        # stage changes selectively
git commit -m "feat: add my new thing"
git push origin feature/my-new-thing
# → open PR on GitHub
```

---

## Development Guidelines

### TypeScript
- Strict mode is enabled. Do not use `any` or `@ts-ignore` without a documented reason.
- Constructor parameter properties and TypeScript enums are disallowed in files used directly by `node --test` (Node 22 type-stripping limitation). Use plain objects/constants instead.
- All new API route handlers must use the `guard()` wrapper from `lib/api-guard.ts`.

### Multi-tenancy
- **Every** database query that touches tenant data must be scoped by `organizationId`. Never query a resource by primary key alone across tenant boundaries.
- Use `requireMember`, `requireManager`, or `requireOwner` from `lib/api-guard.ts` on every route that serves tenant data.
- Org IDs in URL parameters are never trusted — always verify membership server-side.

### Database
- All schema changes go in a new numbered file in `scripts/db/`. Name it `NNN_short_description.sql`.
- Scripts must be **idempotent** (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, etc.).
- Never rename or drop columns without a migration plan — existing data and deployed code may depend on them.
- No ORMs. Raw SQL via `pg` pool. Use parameterized queries — no string interpolation in queries.

### AI / OpenAI
- All inference goes through `lib/openai.ts`. Never import the OpenAI SDK directly in page or component files.
- Include a deterministic fallback for every AI-dependent path. A down or slow OpenAI should degrade gracefully, not crash a route.
- Keep prompts in the relevant `lib/` module, not inline in route files.

### Email & SMS
- Use `RESEND_API_KEY` for platform transactional emails (alerts, digests, onboarding).
- Use `OUTREACH_RESEND_API_KEY` for campaign outreach. These must never be the same key.
- Every outbound SMS must include opt-out wording. The linter will catch missing opt-out in message drafts — do not suppress the check.
- All outbound links in emails must point to the client's branded portal URL, not the platform URL.

### Security
- Tenant-provided URLs that the server fetches (logos, webhooks) must go through the SSRF guard in `lib/ssrf-guard.ts`.
- Never log or expose session secrets, API keys, or bearer tokens — not in errors, not in audit logs.
- New public-facing endpoints that accept user input must be rate-limited.

### Styling
- Use Tailwind utility classes for layout and static design.
- Per-org accent colors must use **inline styles** — Tailwind classes are static at build time and cannot be dynamically generated from DB values.

---

## Testing

Tests live in `tests/` and use Node's built-in `node:test` runner.

```bash
# Run a single test file (recommended)
node --test tests/tenant-isolation.test.mjs

# Run all tests (only against a warm dev server)
npm test
```

**Important:** Never run `npm test` (all files in parallel) against a cold or freshly-started server — the parallel DB connections can saturate the pool. Run one file at a time when debugging.

### Writing new tests
- Tests that provision orgs must use the admin API (`POST /api/admin/organizations`) with the correct shape: `{ name, owner: { email }, modules }` — returns `{ organizationId, inviteToken }`.
- Clean up provisioned test orgs at the end of the test with `DELETE /api/admin/organizations/:id`.
- Use `http://localhost:5000` for HTTP tests — `$REPLIT_DEV_DOMAIN` resolves to a private IP inside the container.
- Isolated task-agent environments start with an empty Postgres — apply `scripts/db/*.sql` before running HTTP tests in that context.

---

## Pull Request Process

1. **Check the build:** `npm run typecheck && npm run lint && npm run build` must all pass
2. **Write or update tests** for any changed behavior
3. **Fill out the PR template** completely — especially the "How to test" section
4. **Link the relevant issue or task** in the PR description
5. **Request a review** — at least one approval required before merging
6. **Squash merge** is preferred for feature branches to keep `main` history clean

### PR size
Keep PRs focused. A PR that touches 20+ files across unrelated concerns is hard to review well. Split it into logical chunks.

---

## Commit Message Convention

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary>

[optional body]

[optional footer: BREAKING CHANGE, fixes #issue]
```

| Type | When to use |
|---|---|
| `feat` | New feature or user-visible capability |
| `fix` | Bug fix |
| `perf` | Performance improvement |
| `refactor` | Code restructure without behavior change |
| `test` | Adding or fixing tests |
| `chore` | Tooling, dependencies, config |
| `docs` | Documentation only |
| `security` | Security fix |

**Examples:**
```
feat(discovery): add Google Business Profile unanswered-review signal
fix(campaigns): prevent duplicate leads slipping through +1 phone normalization
chore(deps): bump openai SDK to v5.19.1
security(ssrf): add IP-pinning to logo URL fetch guard
```

---

## Architecture Decisions

Before making significant architectural changes, check `.agents/memory/` for prior decisions and the reasoning behind them. Key documents:

| File | Covers |
|---|---|
| `embed-security-model.md` | Why embed tokens ride query strings |
| `per-org-theming.md` | Why accent colors use inline styles, not CSS vars |
| `crm-pull-semantics.md` | Why inbound CRM pull only updates existing leads |
| `ssrf-guard-dev-domain.md` | Why server-side tests use localhost, not $REPLIT_DEV_DOMAIN |
| `test-suite-serialization.md` | Why tests must run one file at a time |

If you're making a decision that affects any of these areas, document your reasoning in the PR description.
