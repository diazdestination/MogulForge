---
name: Task-environment setup
description: What a fresh isolated task environment is missing before the MogulForge test suite can run.
---

Isolated task environments for this project can start with an **empty Postgres** (no tables, even though the parent project's DB has them) and **missing node_modules packages**.

**Why:** During one task session, `tsc` failed on a missing `xlsx` package and a new migration failed with "relation does not exist" — both because the task env was fresh, not because anything was broken.

**How to apply:** Before running the HTTP test suite (`npm test` needs the dev server + DATABASE_URL + ADMIN_PASSWORD):
1. `npm install` (xlsx comes from the SheetJS CDN tarball pinned in package.json).
2. Apply all migrations in order: `for f in scripts/db/*.sql; do psql "$DATABASE_URL" -f $f; done` (they are idempotent).
3. Restart the "Start application" workflow so tests hit fresh code on port 5000.

**Symptom of a missing migration:** API routes hang for minutes (admin login took 5 min) while the workflow log floods with "relation ... does not exist" from the `instrumentation.ts` background retry timer — the failing timer starves the dev server. Fix = apply migrations, then restart the workflow (the server stays wedged until restarted).
