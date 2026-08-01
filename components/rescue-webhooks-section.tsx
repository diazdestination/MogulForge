"use client";
import { useCallback, useEffect, useState } from "react";
import { box, btn, btnGhost, input } from "@/components/rescue-integrations-panel";

type IncomingEndpoint = {
  id: string;
  name: string;
  token: string;
  secret: string;
  status: "active" | "disabled";
  lastEventAt: string | null;
};
type IncomingEvent = {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  status: string;
  result: string | null;
  error: string | null;
  createdAt: string;
};
type OutgoingEndpoint = {
  id: string;
  url: string;
  description: string | null;
  secret: string;
  eventTypes: string[];
  status: "active" | "disabled";
  failureCount: number;
};
type Delivery = {
  id: string;
  endpointId: string;
  eventType: string;
  status: string;
  attempts: number;
  nextAttemptAt: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: string;
};

export function RescueWebhooksSection({ orgId }: { orgId: string }) {
  const [incoming, setIncoming] = useState<IncomingEndpoint[]>([]);
  const [events, setEvents] = useState<IncomingEvent[]>([]);
  const [incomingTypes, setIncomingTypes] = useState<string[]>([]);
  const [outgoing, setOutgoing] = useState<OutgoingEndpoint[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [outgoingTypes, setOutgoingTypes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [inName, setInName] = useState("");
  const [outForm, setOutForm] = useState<{ url: string; description: string; eventTypes: string[] }>({ url: "", description: "", eventTypes: [] });
  const appOrigin = typeof window !== "undefined" ? window.location.origin : "";

  const load = useCallback(async () => {
    try {
      const [inRes, outRes] = await Promise.all([
        fetch(`/api/orgs/${orgId}/integrations/incoming-webhooks`, { cache: "no-store" }),
        fetch(`/api/orgs/${orgId}/integrations/outgoing-webhooks`, { cache: "no-store" }),
      ]);
      const inBody = await inRes.json().catch(() => null);
      const outBody = await outRes.json().catch(() => null);
      if (!inRes.ok || !outRes.ok) {
        setError(inBody?.error ?? outBody?.error ?? "Could not load webhooks.");
        return;
      }
      setIncoming(inBody.endpoints);
      setEvents(inBody.events);
      setIncomingTypes(inBody.eventTypes);
      setOutgoing(outBody.endpoints);
      setDeliveries(outBody.deliveries);
      setOutgoingTypes(outBody.eventTypes);
      setError("");
    } catch {
      setError("Could not load webhooks.");
    }
  }, [orgId]);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  async function post(url: string, bodyJson?: unknown, method = "POST") {
    setBusy(true);
    setNotice("");
    try {
      const res = await fetch(url, {
        method,
        ...(bodyJson !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(bodyJson) } : {}),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? "Request failed.");
        return null;
      }
      setError("");
      await load();
      return body;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-red-300">{error}</p>}
      {notice && <p className="text-sm text-forge-lime">{notice}</p>}

      <div className={box}>
        <p className="text-sm font-bold">Incoming webhooks — send events to Revenue Rescue</p>
        <p className="mt-1 text-xs text-white/50">
          Each endpoint gets a unique URL and signing secret. Sign requests with HMAC-SHA256:{" "}
          <code>X-RevenueRescue-Signature: v1=hex(hmac(secret, timestamp + &quot;.&quot; + body))</code> and{" "}
          <code>X-RevenueRescue-Timestamp</code> (unix seconds, ±5 min). Supported events: {incomingTypes.join(", ")}.
        </p>
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const created = await post(`/api/orgs/${orgId}/integrations/incoming-webhooks`, { name: inName });
            if (created) setInName("");
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-white/60">
            Endpoint name
            <input className={input} required maxLength={100} placeholder="e.g. Website forms" value={inName} onChange={(e) => setInName(e.target.value)} />
          </label>
          <button className={btn} disabled={busy}>
            Create endpoint
          </button>
        </form>
        {incoming.length > 0 && (
          <div className="mt-4 space-y-3">
            {incoming.map((ep) => (
              <div key={ep.id} className="rounded-xl border border-white/10 bg-black/20 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-bold">
                    {ep.name} <span className={ep.status === "active" ? "text-forge-lime" : "text-red-300"}>({ep.status})</span>
                  </p>
                  <div className="flex gap-2">
                    <button
                      className={btnGhost}
                      disabled={busy}
                      onClick={() =>
                        post(`/api/orgs/${orgId}/integrations/incoming-webhooks/${ep.id}`, { status: ep.status === "active" ? "disabled" : "active" }, "PATCH")
                      }
                    >
                      {ep.status === "active" ? "Disable" : "Enable"}
                    </button>
                    <button
                      className={btnGhost}
                      disabled={busy}
                      onClick={() => {
                        if (confirm("Delete this endpoint? Senders will start getting 401s.")) {
                          void post(`/api/orgs/${orgId}/integrations/incoming-webhooks/${ep.id}`, undefined, "DELETE");
                        }
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                <p className="mt-2 break-all font-mono text-xs text-white/60">URL: {appOrigin}/api/webhooks/incoming/{ep.token}</p>
                <p className="mt-1 break-all font-mono text-xs text-white/60">Secret: {ep.secret}</p>
              </div>
            ))}
          </div>
        )}
        {events.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <p className="text-xs font-bold uppercase tracking-wider text-white/40">Recent events</p>
            <table className="mt-2 w-full text-left text-xs">
              <thead className="text-white/40">
                <tr>
                  <th className="py-1 pr-4">Event</th>
                  <th className="py-1 pr-4">Type</th>
                  <th className="py-1 pr-4">Status</th>
                  <th className="py-1 pr-4">Detail</th>
                  <th className="py-1">Received</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {events.map((ev) => (
                  <tr key={ev.id}>
                    <td className="max-w-[140px] truncate py-1.5 pr-4 font-mono text-white/60">{ev.eventId}</td>
                    <td className="py-1.5 pr-4">{ev.eventType}</td>
                    <td className={`py-1.5 pr-4 ${ev.status === "failed" ? "text-red-300" : ev.status === "processed" ? "text-forge-lime" : "text-white/60"}`}>{ev.status}</td>
                    <td className="max-w-[260px] truncate py-1.5 pr-4 text-white/50">{ev.error ?? ev.result ?? "—"}</td>
                    <td className="py-1.5 text-white/50">{new Date(ev.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className={box}>
        <p className="text-sm font-bold">Outgoing webhooks — get notified when things happen</p>
        <p className="mt-1 text-xs text-white/50">
          We POST signed JSON to your URL (same signature scheme, using the endpoint secret below). Failed deliveries retry with exponential
          backoff for up to 6 attempts; endpoints that keep failing are disabled automatically.
        </p>
        <form
          className="mt-4 space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const created = await post(`/api/orgs/${orgId}/integrations/outgoing-webhooks`, outForm);
            if (created) setOutForm({ url: "", description: "", eventTypes: [] });
          }}
        >
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-[280px] flex-1 flex-col gap-1 text-xs text-white/60">
              Destination URL
              <input className={input} required placeholder="https://example.com/hooks/revenue-rescue" value={outForm.url} onChange={(e) => setOutForm({ ...outForm, url: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-white/60">
              Description (optional)
              <input className={input} maxLength={200} value={outForm.description} onChange={(e) => setOutForm({ ...outForm, description: e.target.value })} />
            </label>
            <button className={btn} disabled={busy || outForm.eventTypes.length === 0}>
              Add endpoint
            </button>
          </div>
          <div className="flex flex-wrap gap-3">
            {outgoingTypes.map((type) => (
              <label key={type} className="flex items-center gap-1.5 text-xs text-white/70">
                <input
                  type="checkbox"
                  checked={outForm.eventTypes.includes(type)}
                  onChange={(e) =>
                    setOutForm({ ...outForm, eventTypes: e.target.checked ? [...outForm.eventTypes, type] : outForm.eventTypes.filter((t) => t !== type) })
                  }
                />
                <code>{type}</code>
              </label>
            ))}
          </div>
        </form>

        {outgoing.length > 0 && (
          <div className="mt-4 space-y-3">
            {outgoing.map((ep) => (
              <div key={ep.id} className="rounded-xl border border-white/10 bg-black/20 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="break-all font-mono text-xs">{ep.url}</p>
                  <div className="flex gap-2">
                    <button
                      className={btnGhost}
                      disabled={busy}
                      onClick={async () => {
                        const body = await post(`/api/orgs/${orgId}/integrations/outgoing-webhooks/${ep.id}/test`);
                        if (body?.delivery) {
                          setNotice(
                            body.delivery.status === "succeeded"
                              ? `Test delivered (HTTP ${body.delivery.lastStatusCode}).`
                              : `Test failed: ${body.delivery.lastError ?? `HTTP ${body.delivery.lastStatusCode ?? "?"}`}`,
                          );
                        }
                      }}
                    >
                      Send test
                    </button>
                    <button
                      className={btnGhost}
                      disabled={busy}
                      onClick={() =>
                        post(`/api/orgs/${orgId}/integrations/outgoing-webhooks/${ep.id}`, { status: ep.status === "active" ? "disabled" : "active" }, "PATCH")
                      }
                    >
                      {ep.status === "active" ? "Disable" : "Enable"}
                    </button>
                    <button
                      className={btnGhost}
                      disabled={busy}
                      onClick={() => {
                        if (confirm("Delete this endpoint and its delivery history?")) {
                          void post(`/api/orgs/${orgId}/integrations/outgoing-webhooks/${ep.id}`, undefined, "DELETE");
                        }
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                <p className="mt-2 text-xs text-white/50">
                  <span className={ep.status === "active" ? "text-forge-lime" : "text-red-300"}>{ep.status}</span> · events:{" "}
                  {ep.eventTypes.join(", ")}
                  {ep.failureCount > 0 ? ` · ${ep.failureCount} consecutive failures` : ""}
                </p>
                <p className="mt-1 break-all font-mono text-xs text-white/50">Signing secret: {ep.secret}</p>
              </div>
            ))}
          </div>
        )}

        {deliveries.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <p className="text-xs font-bold uppercase tracking-wider text-white/40">Recent deliveries</p>
            <table className="mt-2 w-full text-left text-xs">
              <thead className="text-white/40">
                <tr>
                  <th className="py-1 pr-4">Event</th>
                  <th className="py-1 pr-4">Status</th>
                  <th className="py-1 pr-4">Attempts</th>
                  <th className="py-1 pr-4">Last result</th>
                  <th className="py-1 pr-4">Created</th>
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {deliveries.map((d) => (
                  <tr key={d.id}>
                    <td className="py-1.5 pr-4">{d.eventType}</td>
                    <td className={`py-1.5 pr-4 ${d.status === "succeeded" ? "text-forge-lime" : d.status === "failed" || d.status === "exhausted" ? "text-red-300" : "text-white/60"}`}>
                      {d.status}
                    </td>
                    <td className="py-1.5 pr-4 text-white/60">{d.attempts}</td>
                    <td className="max-w-[240px] truncate py-1.5 pr-4 text-white/50">{d.lastError ?? (d.lastStatusCode ? `HTTP ${d.lastStatusCode}` : "—")}</td>
                    <td className="py-1.5 pr-4 text-white/50">{new Date(d.createdAt).toLocaleString()}</td>
                    <td className="py-1.5 text-right">
                      {(d.status === "failed" || d.status === "exhausted") && (
                        <button className={btnGhost} disabled={busy} onClick={() => post(`/api/orgs/${orgId}/integrations/deliveries/${d.id}/retry`)}>
                          Retry now
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
