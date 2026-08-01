---
name: Node type-stripping limits in tests
description: TS syntax that breaks node:test direct .ts imports (Node 22 type stripping)
---

Unit tests (`node --test tests/*.test.mjs`) import lib `.ts` files directly via Node 22 type stripping. Type stripping only *erases* types — it cannot *transform* code.

**Rule:** in any lib module a unit test might import, avoid TS syntax that requires transformation:
- constructor parameter properties (`constructor(private x: number)`) → declare fields explicitly and assign in the body
- `enum`, `namespace`, legacy `import =` / `export =`

**Why:** `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` at test time (hit with a rate-limiter class using parameter properties). tsc compiles it fine, so the break only shows up when the test runs.

**How to apply:** keep pure/unit-testable libs to erasable-types-only syntax; also remember `import "server-only"` modules can't be unit-imported at all — test those over HTTP instead.
