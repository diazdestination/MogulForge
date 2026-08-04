---
name: Embed SSR theme testing
description: How to assert per-mount theme overrides in served /embed/* HTML without false positives.
---
- Embed pages must compute inline styles from the merged theme even before the branding fetch resolves (`embedStyles(theme, branding)` with null branding), or the SSR HTML ignores t_* query params.
- **Why:** components originally used default styles until branding loaded, so served HTML never reflected per-mount overrides; test-driven fix applied to all four embed components.
- When asserting hostile params are ignored, Next's flight payload echoes the raw query string into the HTML — assert style-context forms (`background-color:url(`, `border-radius:9999px`, `<img ... javascript:`), not raw substring absence.
