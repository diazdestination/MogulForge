---
name: OG image rendering pitfalls
description: Satori/ImageResponse constraints when embedding org logos in opengraph-image
---
- Satori (`next/og` ImageResponse) 500s ("failed to pipe response") on `<img>` with an unreachable URL or missing width/height. Fetch the logo server-side, inline as a base64 data URL, give explicit width+height, and fall back to text-only on any failure. Reject SVG content-type (unsupported).
- The custom-domain proxy allow-list (portal path prefixes) must include `/opengraph-image`, otherwise portal hosts 307 the OG route to `/`.
