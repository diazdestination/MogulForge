import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Developer Docs — Revenue Rescue API & Embeds",
  description: "Integrate Revenue Rescue into any website or system: REST API, signed webhooks, and secure embeds for React, plain JavaScript, iframes, and server-rendered sites.",
};

const code = "mt-3 overflow-x-auto rounded-xl border border-white/10 bg-black/50 p-4 font-mono text-xs leading-relaxed text-white/80";
const section = "rounded-2xl border border-white/10 bg-white/[0.03] p-8";
const h2 = "font-display text-3xl font-semibold";
const h3 = "mt-8 text-sm font-bold uppercase tracking-wider text-forge-lime";

/** Public developer documentation for the API, webhooks, and embed system. */
export default function DevelopersPage() {
  return (
    <div className="shell py-16">
      <div className="mx-auto max-w-4xl space-y-8">
        <header>
          <p className="eyebrow">Revenue Rescue · Developers</p>
          <h1 className="mt-4 font-display text-5xl font-semibold">API, webhooks & embeds</h1>
          <p className="mt-4 max-w-2xl text-white/60">
            Revenue Rescue is centrally hosted — your client sites integrate with it instead of copying it. Everything below is managed from
            your dashboard under <span className="text-white">Revenue Rescue → Integrations</span>.
          </p>
        </header>

        <section className={section}>
          <h2 className={h2}>REST API</h2>
          <p className="mt-3 text-sm text-white/60">
            Base URL: <code>/api/v1</code>. Authenticate with a scoped API key in the <code>Authorization</code> header. Keys are created on
            the Integrations page, shown once, and stored hashed.
          </p>
          <pre className={code}>{`curl https://YOUR-APP-DOMAIN/api/v1/leads?limit=25&stage=imported \\
  -H "Authorization: Bearer rrk_XXXXXXXX_..."`}</pre>
          <h3 className={h3}>Resources</h3>
          <ul className="mt-3 grid gap-1.5 text-sm text-white/60 sm:grid-cols-2">
            <li><code>GET/POST /v1/leads</code>, <code>GET /v1/leads/:id</code></li>
            <li><code>GET /v1/imports</code>, <code>GET /v1/imports/:id</code></li>
            <li><code>GET /v1/campaigns</code>, <code>GET/PATCH /v1/campaigns/:id</code></li>
            <li><code>GET /v1/messages?lead_id=…</code></li>
            <li><code>GET /v1/conversations</code></li>
            <li><code>GET/POST /v1/appointments</code>, <code>GET/PATCH /v1/appointments/:id</code></li>
            <li><code>GET /v1/metrics</code></li>
            <li><code>GET/POST /v1/webhooks</code>, <code>…/:id</code>, <code>…/:id/test</code></li>
            <li><code>GET /v1/usage</code></li>
            <li><code>POST /v1/embed/sessions</code></li>
          </ul>
          <h3 className={h3}>Conventions</h3>
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-white/60">
            <li>
              <span className="text-white">Scopes.</span> Each key carries scopes like <code>leads:read</code> or <code>campaigns:write</code>;
              a request outside the key&apos;s scopes returns <code>403 insufficient_scope</code>.
            </li>
            <li>
              <span className="text-white">Pagination.</span> <code>?limit=</code> (1–100, default 25) and <code>?offset=</code>. List responses
              return <code>{`{ data, pagination: { limit, offset, total, has_more } }`}</code>.
            </li>
            <li>
              <span className="text-white">Errors.</span> Always <code>{`{ error: { code, message, details? } }`}</code> with a meaningful HTTP status.
            </li>
            <li>
              <span className="text-white">Rate limits.</span> Default 120 requests/minute per key. Watch the <code>X-RateLimit-*</code> response
              headers; <code>429 rate_limited</code> includes <code>Retry-After</code>.
            </li>
            <li>
              <span className="text-white">Idempotency.</span> Send an <code>Idempotency-Key</code> header on <code>POST /v1/leads</code> and{" "}
              <code>POST /v1/appointments</code> to retry safely — replays return the stored response with{" "}
              <code>Idempotency-Replayed: true</code>.
            </li>
          </ul>
          <h3 className={h3}>Create a lead</h3>
          <pre className={code}>{`curl -X POST https://YOUR-APP-DOMAIN/api/v1/leads \\
  -H "Authorization: Bearer rrk_..." \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order-8412-lead" \\
  -d '{
    "firstName": "Jordan", "lastName": "Rivera",
    "email": "jordan@example.com", "phone": "(555) 201-7788",
    "projectType": "Roof replacement", "estimatedValue": 14500,
    "source": "website"
  }'`}</pre>
        </section>

        <section className={section}>
          <h2 className={h2}>Webhooks</h2>
          <h3 className={h3}>Signature scheme (both directions)</h3>
          <p className="mt-3 text-sm text-white/60">
            Payloads are signed with HMAC-SHA256. The signed string is <code>{`{timestamp}.{rawBody}`}</code>; timestamps older than 5 minutes
            are rejected to block replays.
          </p>
          <pre className={code}>{`X-RevenueRescue-Timestamp: 1767225600
X-RevenueRescue-Signature: v1=8f2a...c91

// verify (Node.js)
const crypto = require("crypto");
const expected = "v1=" + crypto.createHmac("sha256", SECRET)
  .update(timestamp + "." + rawBody).digest("hex");
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));`}</pre>
          <h3 className={h3}>Incoming — send events to Revenue Rescue</h3>
          <p className="mt-3 text-sm text-white/60">
            Create an incoming endpoint on the Integrations page to get a unique URL and secret. Events are processed idempotently by their{" "}
            <code>id</code> — safe to retry.
          </p>
          <pre className={code}>{`POST https://YOUR-APP-DOMAIN/api/webhooks/incoming/iwh_...
{ "id": "evt_unique_123", "type": "lead.created",
  "data": { "email": "jordan@example.com", "firstName": "Jordan" } }

// supported types: lead.created, lead.updated, contact.opted_out, job.won, ping`}</pre>
          <p className="mt-3 text-sm text-white/60">
            <code>lead.updated</code> never silently overwrites newer local data — ambiguous updates become sync conflicts for manual review.
          </p>
          <h3 className={h3}>Outgoing — get notified by Revenue Rescue</h3>
          <p className="mt-3 text-sm text-white/60">
            Register a URL and pick event types (<code>lead.created</code>, <code>lead.opted_out</code>, <code>campaign.status_changed</code>,{" "}
            <code>appointment.created</code>, <code>appointment.updated</code>, …). Deliveries are signed with your endpoint&apos;s secret and
            retried with exponential backoff (up to 6 attempts); you can send test pings and retry failures manually from the dashboard.
          </p>
        </section>

        <section className={section}>
          <h2 className={h2}>Secure embeds</h2>
          <p className="mt-3 text-sm text-white/60">
            Embed the client dashboard or a lead-capture widget on any site. Tokens are short-lived (15 minutes by default), issued
            server-to-server, and bound to an approved origin — pages refuse to frame anywhere else via <code>frame-ancestors</code> CSP, and
            every embed API call re-validates the token and origin.
          </p>
          <h3 className={h3}>1 · Issue a token (server-side only)</h3>
          <pre className={code}>{`// Node.js / Express example — keep your API key on the server
app.get("/api/rr-token", async (req, res) => {
  const r = await fetch("https://YOUR-APP-DOMAIN/api/v1/embed/sessions", {
    method: "POST",
    headers: { authorization: "Bearer " + process.env.RR_API_KEY,
               "content-type": "application/json" },
    body: JSON.stringify({ origin: "https://www.yourclientsite.com",
                           modules: ["dashboard"], role: "viewer" })
  });
  const body = await r.json();
  res.json({ token: body.data.token });
});`}</pre>
          <h3 className={h3}>2a · Plain JavaScript</h3>
          <pre className={code}>{`<script src="https://YOUR-APP-DOMAIN/embed/v1/loader.js" async></script>
<div id="rr-dash"></div>
<script>
  fetch("/api/rr-token").then(r => r.json()).then(({ token }) => {
    window.RevenueRescue.mount(document.getElementById("rr-dash"),
      { token: token, module: "dashboard" });
  });
</script>

<!-- or declaratively, if the token is rendered into the page -->
<div data-rr-embed="lead_form" data-rr-token="TOKEN"></div>`}</pre>
          <h3 className={h3}>2b · React</h3>
          <pre className={code}>{`import { useEffect, useRef } from "react";

export function RevenueRescueDashboard() {
  const ref = useRef(null);
  useEffect(() => {
    let mounted;
    const load = async () => {
      if (!window.RevenueRescue) {
        await new Promise((ok) => {
          const s = document.createElement("script");
          s.src = "https://YOUR-APP-DOMAIN/embed/v1/loader.js";
          s.onload = ok; document.head.appendChild(s);
        });
      }
      const { token } = await fetch("/api/rr-token").then((r) => r.json());
      mounted = window.RevenueRescue.mount(ref.current, { token, module: "dashboard" });
    };
    load();
    return () => mounted?.destroy();
  }, []);
  return <div ref={ref} />;
}`}</pre>
          <h3 className={h3}>2c · Direct iframe</h3>
          <pre className={code}>{`<iframe
  src="https://YOUR-APP-DOMAIN/embed/dashboard?token=TOKEN_FROM_YOUR_SERVER"
  style="width:100%;border:0;height:600px"></iframe>`}</pre>
          <h3 className={h3}>2d · Server-rendered sites (PHP, Rails, Django, …)</h3>
          <pre className={code}>{`// Fetch the token during page render, then print the embed markup:
<?php
$resp = http_post("https://YOUR-APP-DOMAIN/api/v1/embed/sessions", [
  "origin" => "https://www.yourclientsite.com", "modules" => ["lead_form"]
], ["Authorization: Bearer " . getenv("RR_API_KEY")]);
$token = json_decode($resp, true)["data"]["token"];
?>
<script src="https://YOUR-APP-DOMAIN/embed/v1/loader.js" async></script>
<div data-rr-embed="lead_form" data-rr-token="<?= htmlspecialchars($token) ?>"></div>`}</pre>
          <p className="mt-4 text-sm text-white/60">
            Modules: <code>dashboard</code>, <code>leads</code>, <code>appointments</code>, <code>lead_form</code>. Tokens expire — re-issue on
            page load rather than caching them.
          </p>
        </section>

        <section className={section}>
          <h2 className={h2}>CRM sync</h2>
          <p className="mt-3 text-sm text-white/60">
            The generic webhook/REST adapter pushes mapped lead data to any HTTP endpoint (works with Zapier, Make, and n8n catch hooks).
            Field mapping supports transforms (title case, US phone normalization, combined full name, …) and a test-before-activate flow.
            Native connectors for HubSpot, GoHighLevel, JobNimbus, ServiceTitan, and Salesforce are in development — their status is shown
            honestly on the Integrations page.
          </p>
        </section>
      </div>
    </div>
  );
}
