---
name: Test suite serialization
description: HTTP integration tests must run one file at a time against the dev server
---
Rule: run `node --test tests/<one-file>.test.mjs` serially; do not run the whole `tests/*.test.mjs` glob at once against `next dev`.
**Why:** each test file provisions orgs over live HTTP; a dozen concurrent files queue admin/provisioning requests for minutes and can leave the dev server wedged (requests hang until a workflow restart).
**How to apply:** before HTTP tests, restart the workflow if requests hang; then run target test files individually with generous timeouts.
