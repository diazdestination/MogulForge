---
name: Embed SSR theme testing
description: How to assert per-mount theme overrides in served /embed/* HTML without false positives.
---
- Embed pages must compute inline styles from the merged theme even before the branding fetch resolves (`embedStyles(theme, branding)` with null branding), or the SSR HTML ignores t_* query params.
- **Why:** components originally used default styles until branding loaded, so served HTML never reflected per-mount overrides; test-driven fix applied to all four embed components.
- Data-loading embed modules (leads/appointments) SSR only their loading shell, which merges the muted color over the root style — assert the themed background + muted color; the root text color and control radii never appear in initial HTML.
- If every route except `/` starts returning 404 in dev, the `.next` cache is stale — `rm -rf .next` and restart the workflow.
- When asserting hostile params are ignored, Next's flight payload echoes the raw query string into the HTML — assert style-context forms (`background-color:url(`, `border-radius:9999px`, `<img ... javascript:`), not raw substring absence.
