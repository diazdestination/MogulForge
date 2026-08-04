## Summary

<!-- One or two sentences: what does this PR do and why? -->

## Type of Change

- [ ] Bug fix
- [ ] New feature
- [ ] Performance improvement
- [ ] Refactor (no behavior change)
- [ ] Security fix
- [ ] Documentation
- [ ] Dependency update

## Related Issue / Task

Closes #<!-- issue number -->

## Changes

<!-- Bullet-point list of the key changes made. Be specific about files and behavior. -->

-
-
-

## Database Migrations

- [ ] No database changes
- [ ] New migration file added in `scripts/db/` (idempotent ✅)

## How to Test

<!-- Step-by-step instructions for a reviewer to verify this works correctly. -->

1.
2.
3.

Expected result:

## Security Checklist

- [ ] No secrets, API keys, or tokens introduced in code
- [ ] New API routes use `guard()` / `requireMember()` from `lib/api-guard.ts`
- [ ] Tenant-provided URLs that the server fetches go through the SSRF guard
- [ ] New outbound SMS messages include opt-out wording
- [ ] Email links point to the client's branded portal, not the platform URL

## Pre-merge Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm run build` passes
- [ ] Relevant tests added or updated
- [ ] Migration is idempotent (if applicable)
- [ ] `.env.example` updated (if new env vars introduced)
