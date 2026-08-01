---
name: Per-org theming
description: How org-specific branding colors must be applied given the static Tailwind setup.
---

Tailwind (v3) colors in this project are **static hex values in `tailwind.config.ts`** (e.g. `forge.lime`), compiled at build time. CSS-variable color overrides do NOT restyle Tailwind utility classes.

**Why:** Attempting per-organization accent colors via CSS custom properties had no effect on `bg-forge-lime`-style classes; the hex is baked into the generated CSS.

**How to apply:** Any per-org/white-label theming (dashboard branding strip, embed widgets, accent buttons/bars) must use **inline `style` attributes** with the org's stored hex color, not Tailwind classes or CSS vars. Validate colors as hex before rendering.
