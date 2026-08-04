# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| `main` (latest) | ✅ Active |
| Any pinned release | Contact us |

---

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, email us at: **security@mogulforge.com**

Include in your report:
- A description of the vulnerability and its potential impact
- Steps to reproduce (proof-of-concept, if possible)
- The affected component(s) or endpoints
- Any suggested mitigations you've identified

We will acknowledge your report within **48 hours** and aim to provide a resolution timeline within **7 days** for critical issues.

We do not currently operate a bug bounty program, but we deeply appreciate responsible disclosure and will credit researchers (with your consent) in the changelog.

---

## Security Architecture

### Authentication & Sessions
- Sessions use HMAC-signed cookies (`mf_session`) via `SESSION_SECRET` — a 32+ character random string
- Passwords are hashed with scrypt (memory-hard, replay-resistant)
- Session cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` in production
- Admin access uses a separate `ADMIN_PASSWORD` flow — platform admins are tracked in `users.platform_role`

### Multi-Tenant Isolation
- Every database query that touches tenant data is scoped by `organizationId`
- Org IDs in URL parameters are validated server-side on every request — they are never trusted at face value
- The `requireMember` / `requireManager` / `requireOwner` guards in `lib/api-guard.ts` are enforced on every tenant API route

### SSRF Protection
- Tenant-provided URLs (logos, webhook endpoints) that the server fetches are validated at write time and at fetch time
- Fetch is DNS-vetted and IP-pinned to block requests to RFC-1918 and loopback ranges
- HTTP redirects from tenant-provided URLs are refused
- The `REPLIT_DEV_DOMAIN` resolves to a private IP inside the container — server-side tests use `localhost` to avoid inadvertent private-network exposure

### API Security
- All public-facing endpoints that accept user input are rate-limited using a sliding-window algorithm
- The bot trap on the public scan form silently rejects automated submissions without revealing the trap exists
- Webhook delivery signatures are verified using `RESEND_WEBHOOK_SECRET` before processing

### Secret Management
- API keys, session secrets, and bearer tokens are loaded exclusively from environment variables — never hardcoded or committed
- The OpenAI API key is server-side only and never reaches the browser
- The outreach Resend key (`OUTREACH_RESEND_API_KEY`) is separate from the platform Resend key to limit blast radius
- `.env.local` is in `.gitignore` and must never be committed

### Concurrency & Data Integrity
- Advisory locks prevent concurrent processing of the same CRM connection or lead analysis batch across multiple server instances
- Atomic partial-unique indexes enforce business invariants (e.g., one active run per org) at the database level

### Embed Security
- Embed tokens are short-lived JWTs passed in the iframe query string so the proxy can enforce per-org `frame-ancestors` CSP headers
- Origin checks are performed on every embed request

---

## Known Limitations

- Email sender domains start on `onboarding@resend.dev` until the client's custom domain is verified with Resend. Clients should complete domain verification before going live to maximize deliverability.
- The `TWILIO_PHONE_NUMBER` fallback sends from a shared number. Clients should configure a dedicated Messaging Service SID for best deliverability and compliance.
- Google Business Profile signals require the `business.manage` OAuth scope — this must be explicitly granted by the client.

---

## Dependency Security

Dependencies are monitored for known vulnerabilities. If you discover a vulnerability in a dependency:

1. Check whether an updated version is available and compatible
2. Open a PR with the upgrade, noting the CVE or advisory reference
3. If no fix is available, open an issue tagged `security` describing the exposure

Notable pinned dependency: `xlsx` is installed from the SheetJS CDN tarball at version 0.20.3. Do not downgrade to npm 0.18.5 — that version contains a known vulnerability.
