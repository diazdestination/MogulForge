export const runtime = "nodejs";
export const dynamic = "force-static";

/**
 * The embed loader script served to client sites. Mounts Revenue Rescue modules
 * as sandboxed iframes; the token is short-lived and origin-bound, so the iframe
 * only renders on approved origins (enforced again by frame-ancestors CSP).
 */
const LOADER_SOURCE = `(function () {
  "use strict";
  var MODULE_PATHS = { dashboard: "/embed/dashboard", leads: "/embed/leads", appointments: "/embed/appointments", lead_form: "/embed/widget" };

  function resolveBase(explicit) {
    if (explicit) return explicit.replace(/\\/$/, "");
    var current = document.currentScript && document.currentScript.src;
    if (current) { var u = new URL(current); return u.origin; }
    return "";
  }

  var HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  var RADII = ["none", "sm", "md", "lg", "xl"];

  // Validates theme options and returns extra query params for the iframe URL.
  // Only vetted values pass through (hex colors, enum radii, https logo URLs) —
  // the embedded page re-validates everything, so no arbitrary CSS can ride along.
  function themeParams(theme) {
    if (!theme || typeof theme !== "object") return "";
    var out = "";
    if (theme.mode === "dark" || theme.mode === "light") out += "&t_mode=" + theme.mode;
    if (typeof theme.accentColor === "string" && HEX_RE.test(theme.accentColor)) out += "&t_accent=" + encodeURIComponent(theme.accentColor);
    if (typeof theme.backgroundColor === "string" && HEX_RE.test(theme.backgroundColor)) out += "&t_bg=" + encodeURIComponent(theme.backgroundColor);
    if (typeof theme.radius === "string" && RADII.indexOf(theme.radius) !== -1) out += "&t_radius=" + theme.radius;
    if (typeof theme.logoUrl === "string" && /^https:\\/\\//i.test(theme.logoUrl) && theme.logoUrl.length <= 500) out += "&t_logo=" + encodeURIComponent(theme.logoUrl);
    return out;
  }

  // Liveness heartbeat: proves the widget is actually installed and running on
  // the host page. Best-effort — never interferes with rendering. Stops firing
  // once the short-lived token expires (the server ignores expired tokens).
  function sendHeartbeat(base, token, moduleName) {
    try {
      fetch(base + "/api/embed/heartbeat", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ module: moduleName }),
        keepalive: true
      }).catch(function () {});
    } catch (err) { /* fetch unavailable — skip silently */ }
  }

  function mount(el, options) {
    if (!el) throw new Error("RevenueRescue.mount: target element is required");
    var opts = options || {};
    if (!opts.token) throw new Error("RevenueRescue.mount: options.token is required (issue one server-side via POST /api/v1/embed/sessions)");
    var moduleName = opts.module || "dashboard";
    var path = MODULE_PATHS[moduleName] || MODULE_PATHS.dashboard;
    var base = resolveBase(opts.baseUrl);
    var iframe = document.createElement("iframe");
    iframe.src = base + path + "?token=" + encodeURIComponent(opts.token) + "&module=" + encodeURIComponent(moduleName) + themeParams(opts.theme);
    iframe.style.width = "100%";
    iframe.style.border = "0";
    iframe.style.display = "block";
    iframe.style.height = (opts.height || 480) + "px";
    iframe.setAttribute("title", "Revenue Rescue " + moduleName);
    iframe.setAttribute("loading", "lazy");
    el.innerHTML = "";
    el.appendChild(iframe);
    function onMessage(event) {
      if (event.source !== iframe.contentWindow) return;
      var data = event.data || {};
      if (data.type === "rr:resize" && typeof data.height === "number" && !opts.height) {
        iframe.style.height = Math.max(120, Math.min(data.height, 4000)) + "px";
      }
    }
    window.addEventListener("message", onMessage);
    sendHeartbeat(base, opts.token, moduleName);
    var heartbeatTimer = setInterval(function () { sendHeartbeat(base, opts.token, moduleName); }, 5 * 60 * 1000);
    return { iframe: iframe, destroy: function () { clearInterval(heartbeatTimer); window.removeEventListener("message", onMessage); iframe.remove(); } };
  }

  function autoMount() {
    var nodes = document.querySelectorAll("[data-rr-embed]");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.getAttribute("data-rr-mounted")) continue;
      el.setAttribute("data-rr-mounted", "1");
      try {
        mount(el, {
          token: el.getAttribute("data-rr-token"),
          module: el.getAttribute("data-rr-embed") || "dashboard",
          height: el.getAttribute("data-rr-height") ? parseInt(el.getAttribute("data-rr-height"), 10) : undefined,
          baseUrl: el.getAttribute("data-rr-base") || undefined,
          theme: {
            mode: el.getAttribute("data-rr-mode") || undefined,
            accentColor: el.getAttribute("data-rr-accent") || undefined,
            backgroundColor: el.getAttribute("data-rr-background") || undefined,
            radius: el.getAttribute("data-rr-radius") || undefined,
            logoUrl: el.getAttribute("data-rr-logo") || undefined
          }
        });
      } catch (err) { console.error("[RevenueRescue]", err); }
    }
  }

  window.RevenueRescue = window.RevenueRescue || {};
  window.RevenueRescue.mount = mount;
  window.RevenueRescue.autoMount = autoMount;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", autoMount);
  else autoMount();
})();
`;

export function GET() {
  return new Response(LOADER_SOURCE, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
}
