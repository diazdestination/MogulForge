"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { REPLY_CATEGORY_LABELS } from "@/lib/rescue-engage/replies";

type Thread = {
  leadId: string; firstName: string | null; lastName: string | null; suppressed: boolean;
  pipelineStage: string; assignedName: string | null; lastDirection: string;
  lastBody: string; lastSimulated: boolean; lastReplyCategory: string | null; lastMessageAt: string;
  messageCount: number; inboundCount: number;
};

type Task = {
  id: string; leadId: string | null; leadFirstName: string | null; leadLastName: string | null;
  title: string; detail: string | null; source: string; status: string; dueAt: string | null;
  assignedName: string | null; createdAt: string;
};

const box = "rounded-2xl border border-white/10 bg-white/[0.03] p-6";

export function RescueConversationsPanel({ orgId, canWrite }: { orgId: string; canWrite: boolean }) {
  const searchParams = useSearchParams();
  const orgSuffix = searchParams.get("org") ? `?org=${searchParams.get("org")}` : "";
  const [threads, setThreads] = useState<Thread[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [scoped, setScoped] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/orgs/${orgId}/conversations`, { cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.error ?? "Could not load conversations."); return; }
      setThreads(body.conversations);
      setTasks(body.tasks);
      setScoped(body.scopedToAssigned === true);
      setError("");
    } catch { setError("Could not load conversations."); }
  }, [orgId]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  async function completeTask(taskId: string) {
    setBusy(true);
    try {
      await fetch(`/api/orgs/${orgId}/tasks/${taskId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "done" }),
      });
      await load();
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      {scoped && <p className="text-xs text-white/45">Showing conversations for your assigned leads only.</p>}
      {error && <p className="rounded-xl border border-forge-rust/40 bg-forge-rust/10 px-4 py-3 text-sm text-forge-rust">{error}</p>}

      {tasks.length > 0 && (
        <div className={box}>
          <h2 className="font-display text-xl font-semibold">Follow-up tasks</h2>
          <ul className="mt-4 space-y-2">
            {tasks.map((t) => (
              <li key={t.id} className="flex items-start justify-between gap-3 rounded-xl bg-black/30 p-3 text-sm">
                <div className="min-w-0">
                  <p className="font-semibold">
                    {t.source === "escalation" && <span className="mr-2 rounded border border-forge-rust/50 px-1.5 py-0.5 text-[10px] font-bold text-forge-rust">ESCALATION</span>}
                    {t.title}
                  </p>
                  {t.detail && <p className="mt-0.5 text-xs text-white/50">{t.detail}</p>}
                  <p className="mt-1 text-[10px] text-white/40">
                    {t.leadId && <Link href={`/dashboard/revenue-rescue/leads/${t.leadId}${orgSuffix}`} className="text-forge-lime hover:underline">{[t.leadFirstName, t.leadLastName].filter(Boolean).join(" ") || "View lead"}</Link>}
                    {t.assignedName && <span className="ml-2">→ {t.assignedName}</span>}
                    {t.dueAt && <span className="ml-2">due {new Date(t.dueAt).toLocaleDateString()}</span>}
                  </p>
                </div>
                {canWrite && (
                  <button onClick={() => void completeTask(t.id)} disabled={busy} className="btn-secondary shrink-0 px-2.5 py-1 text-[10px]">Done</button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className={box}>
        <h2 className="font-display text-xl font-semibold">Inbox</h2>
        {threads.length === 0 ? (
          <p className="mt-3 text-sm text-white/50">
            No conversations yet. Threads appear when campaigns send (simulated) messages or you log manual outreach and replies from a lead&rsquo;s page.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-white/5">
            {threads.map((t) => (
              <li key={t.leadId}>
                <Link href={`/dashboard/revenue-rescue/leads/${t.leadId}${orgSuffix}`} className="group flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold group-hover:text-forge-lime">
                      {[t.firstName, t.lastName].filter(Boolean).join(" ") || "Unnamed lead"}
                      {t.suppressed && <span className="ml-2 rounded border border-forge-rust/50 px-1.5 py-0.5 text-[10px] font-bold text-forge-rust">SUPPRESSED</span>}
                      {t.lastReplyCategory && (
                        <span className="ml-2 rounded border border-forge-lime/40 px-1.5 py-0.5 text-[10px] text-forge-lime">
                          {REPLY_CATEGORY_LABELS[t.lastReplyCategory as keyof typeof REPLY_CATEGORY_LABELS] ?? t.lastReplyCategory}
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-white/50">
                      <span className="uppercase text-white/35">{t.lastDirection === "inbound" ? "They said" : "Sent"}{t.lastSimulated ? " (simulated)" : ""}:</span> {t.lastBody}
                    </p>
                  </div>
                  <div className="shrink-0 text-right text-xs text-white/40">
                    <p>{new Date(t.lastMessageAt).toLocaleString()}</p>
                    <p className="mt-0.5">{t.messageCount} msg · {t.inboundCount} inbound{t.assignedName ? ` · ${t.assignedName}` : ""}</p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
