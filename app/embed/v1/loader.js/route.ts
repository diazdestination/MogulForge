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

  function mount(el, options) {
    if (!el) throw new Error("RevenueRescue.mount: target element is required");
    var opts = options || {};
    if (!opts.token) throw new Error("RevenueRescue.mount: options.token is required (issue one server-side via POST /api/v1/embed/sessions)");
    var moduleName = opts.module || "dashboard";
    var path = MODULE_PATHS[moduleName] || MODULE_PATHS.dashboard;
    var base = resolveBase(opts.baseUrl);
    var iframe = document.createElement("iframe");
    iframe.src = base + path + "?token=" + encodeURIComponent(opts.token) + "&module=" + encodeURIComponent(moduleName);
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
    return { iframe: iframe, destroy: function () { window.removeEventListener("message", onMessage); iframe.remove(); } };
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
          baseUrl: el.getAttribute("data-rr-base") || undefined
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
