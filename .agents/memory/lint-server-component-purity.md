---
name: Lint purity rule in server components
description: eslint react-hooks/purity flags Date.now()/new Date() inside app/ server components; how to keep lint green
---

The project's eslint config (eslint-config-next 16 with the React compiler rules) applies `react-hooks/purity` to **async server components** too: calling `Date.now()` (or other impure functions) directly inside a page component body is a lint **error**, even though it's perfectly valid in RSC.

**Why:** Hit while building admin pages that filtered invites by expiry — `npm run lint` failed only on those lines; typecheck and runtime were fine.

**How to apply:** Put time-dependent logic in a plain lib helper (e.g. `isInviteActive()` in the data layer) and call that from the component. Cross-module calls are not analyzed by the rule. Also note: `npx eslint app lib components` is the useful check — a bare `npm run lint` drowns in pre-existing errors from `.local/skills/**` template files that are not project code.
