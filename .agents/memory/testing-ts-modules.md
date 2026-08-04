---
name: Testing TS lib modules with node --test
description: Durable constraints for unit-testing TypeScript lib code, and the xlsx install caveat
---

# Testing TS modules directly with node:test

Pure `lib/` TypeScript modules can be unit-tested directly from `tests/*.test.mjs` — but only when their relative imports carry explicit `.ts` extensions and they avoid `server-only` and `@/` path aliases.

**Why:** Node's ESM loader resolves specifiers literally (no extensionless resolution), while Next's bundler resolution accepts both; `allowImportingTsExtensions` keeps tsc happy with the `.ts` suffix.

**How to apply:** Keep testable logic in pure lib modules; leave `server-only` and alias imports to layers covered by e2e HTTP tests.

## Exception: loader hooks for server-only libs

`tests/helpers/server-lib-loader.mjs` (register via `node:module` `register()` before dynamic-importing the lib) stubs `server-only` to an empty module and resolves extensionless relative imports to `.ts`. This lets node:test import DB-touching server libs directly — combine with a global `fetch` stub to record outbound API calls (e.g. Resend) without a dev server. Register first, then use dynamic `import()` for the lib; static imports would resolve before the hooks apply.

# xlsx (SheetJS) install

Install `xlsx` from the SheetJS CDN tarball, never plain `npm install xlsx` — the npm registry's newest release is old and has known vulnerabilities.
