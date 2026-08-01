"use client";
import { useCallback, useEffect, useState } from "react";
import { ORG_ROLES, ROLE_LABELS, type OrgRole } from "@/lib/roles";

type Member = { membershipId: string; userId: string; email: string; name: string; role: OrgRole; createdAt: string };
type Invite = {
  id: string; email: string; name: string | null; role: OrgRole;
  expiresAt: string; acceptedAt: string | null; createdAt: string;
  status: "pending" | "accepted" | "expired"; token: string | null;
};

const box = "rounded-2xl border border-white/10 bg-white/[0.03] p-6";
const input = "rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white";
const INVITABLE_ROLES = ORG_ROLES.filter((role) => role !== "owner");

export function RescueTeamPanel({ orgId, canManage, currentUserId }: { orgId: string; canManage: boolean; currentUserId: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [inviteForm, setInviteForm] = useState({ email: "", name: "", role: "sales_rep" as OrgRole });
  const [copiedInviteId, setCopiedInviteId] = useState("");

  const load = useCallback(async () => {
    try {
      const [membersRes, invitesRes] = await Promise.all([
        fetch(`/api/orgs/${orgId}/members`, { cache: "no-store" }),
        canManage ? fetch(`/api/orgs/${orgId}/invites`, { cache: "no-store" }) : Promise.resolve(null),
      ]);
      const membersBody = await membersRes.json().catch(() => null);
      if (!membersRes.ok) { setError(membersBody?.error ?? "Could not load the team."); return; }
      setMembers(membersBody.members);
      if (invitesRes) {
        const invitesBody = await invitesRes.json().catch(() => null);
        if (invitesRes.ok) setInvites(invitesBody.invites);
      }
      setError("");
    } catch {
      setError("Could not load the team.");
    } finally {
      setLoaded(true);
    }
  }, [orgId, canManage]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  async function mutate(run: () => Promise<Response>, successNotice?: string) {
    setBusy(true);
    setNotice("");
    try {
      const res = await run();
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.error ?? "The action failed."); return null; }
      setError("");
      if (successNotice) setNotice(successNotice);
      await load();
      return body;
    } catch {
      setError("The action failed.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(member: Member, role: string) {
    await mutate(() => fetch(`/api/orgs/${orgId}/members/${member.membershipId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role }),
    }), `${member.name || member.email} is now ${ROLE_LABELS[role as OrgRole] ?? role}.`);
  }

  async function remove(member: Member) {
    if (!window.confirm(`Remove ${member.name || member.email} from this organization? They lose dashboard access immediately.`)) return;
    await mutate(() => fetch(`/api/orgs/${orgId}/members/${member.membershipId}`, { method: "DELETE" }),
      `${member.name || member.email} was removed.`);
  }

  async function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    const body = await mutate(() => fetch(`/api/orgs/${orgId}/members`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: inviteForm.email, name: inviteForm.name || undefined, role: inviteForm.role }),
    }), `Invite created for ${inviteForm.email}. Copy the link below and send it to them.`);
    if (body) setInviteForm({ email: "", name: "", role: "sales_rep" });
  }

  async function revoke(invite: Invite) {
    if (!window.confirm(`Revoke the invite for ${invite.email}? Their invite link stops working immediately.`)) return;
    await mutate(() => fetch(`/api/orgs/${orgId}/invites/${invite.id}`, { method: "DELETE" }),
      `Invite for ${invite.email} was revoked.`);
  }

  async function copyInviteLink(invite: Invite) {
    if (!invite.token) return;
    const link = `${window.location.origin}/invite/${invite.token}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopiedInviteId(invite.id);
      setTimeout(() => setCopiedInviteId(""), 2000);
    } catch {
      window.prompt("Copy this invite link:", link);
    }
  }

  const pendingInvites = invites.filter((i) => i.status === "pending");
  const expiredInvites = invites.filter((i) => i.status === "expired");

  return (
    <div className="space-y-6">
      {error && <p className="rounded-xl border border-forge-rust/40 bg-forge-rust/10 px-4 py-3 text-sm text-forge-rust">{error}</p>}
      {notice && <p className="rounded-xl border border-forge-lime/40 bg-forge-lime/10 px-4 py-3 text-sm text-forge-lime">{notice}</p>}
      {!canManage && loaded && <p className="text-xs text-white/45">You have read-only access to the team list. Ask an owner or admin to make changes.</p>}

      <div className={box}>
        <h2 className="font-display text-xl font-semibold">Members</h2>
        {!loaded ? (
          <p className="mt-4 text-sm text-white/50">Loading team…</p>
        ) : members.length === 0 ? (
          <p className="mt-4 text-sm text-white/50">No members yet.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-[10px] uppercase tracking-wider text-white/40">
                <tr><th className="pb-2">Member</th><th className="pb-2">Role</th><th className="pb-2">Joined</th>{canManage && <th className="pb-2 text-right">Actions</th>}</tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {members.map((member) => {
                  const isSelf = member.userId === currentUserId;
                  const isOwner = member.role === "owner";
                  return (
                    <tr key={member.membershipId}>
                      <td className="py-2.5 pr-3">
                        <p className="font-semibold">{member.name || member.email}{isSelf && <span className="ml-2 rounded border border-white/20 px-1.5 py-0.5 text-[10px] font-bold uppercase text-white/50">You</span>}</p>
                        <p className="text-xs text-white/45">{member.email}</p>
                      </td>
                      <td className="py-2.5 pr-3">
                        {canManage && !isOwner ? (
                          <select value={member.role} disabled={busy} onChange={(e) => void changeRole(member, e.target.value)} className={`${input} py-1 text-xs`}>
                            {INVITABLE_ROLES.map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
                          </select>
                        ) : (
                          <span className="text-xs">{ROLE_LABELS[member.role]}</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-xs text-white/50">{new Date(member.createdAt).toLocaleDateString()}</td>
                      {canManage && (
                        <td className="py-2.5 text-right">
                          {!isOwner && !isSelf && (
                            <button type="button" disabled={busy} onClick={() => void remove(member)} className="text-xs font-bold text-forge-rust hover:underline disabled:opacity-40">
                              Remove
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {canManage && (
        <>
          <form onSubmit={sendInvite} className={`${box} flex flex-wrap items-end gap-3`}>
            <div>
              <h2 className="w-full font-display text-xl font-semibold">Invite someone</h2>
              <p className="mt-1 text-xs text-white/45">Creates an invite link you share with them — valid for 14 days.</p>
            </div>
            <label className="block text-xs text-white/55">Email
              <input type="email" required value={inviteForm.email} onChange={(e) => setInviteForm({ ...inviteForm, email: e.target.value })} placeholder="teammate@company.com" className={`${input} mt-1 block w-56`} />
            </label>
            <label className="block text-xs text-white/55">Name
              <input value={inviteForm.name} onChange={(e) => setInviteForm({ ...inviteForm, name: e.target.value })} placeholder="Optional" className={`${input} mt-1 block w-40`} />
            </label>
            <label className="block text-xs text-white/55">Role
              <select value={inviteForm.role} onChange={(e) => setInviteForm({ ...inviteForm, role: e.target.value as OrgRole })} className={`${input} mt-1 block`}>
                {INVITABLE_ROLES.map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
              </select>
            </label>
            <button type="submit" disabled={busy || !inviteForm.email} className="btn-primary px-4 py-2 text-xs disabled:opacity-40">Send invite</button>
          </form>

          <div className={box}>
            <h2 className="font-display text-xl font-semibold">Pending invites</h2>
            {pendingInvites.length === 0 ? (
              <p className="mt-4 text-sm text-white/50">No pending invites.</p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="text-[10px] uppercase tracking-wider text-white/40">
                    <tr><th className="pb-2">Invitee</th><th className="pb-2">Role</th><th className="pb-2">Expires</th><th className="pb-2 text-right">Actions</th></tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {pendingInvites.map((invite) => (
                      <tr key={invite.id}>
                        <td className="py-2.5 pr-3">
                          <p className="font-semibold">{invite.email}</p>
                          {invite.name && <p className="text-xs text-white/45">{invite.name}</p>}
                        </td>
                        <td className="py-2.5 pr-3 text-xs">{ROLE_LABELS[invite.role]}</td>
                        <td className="py-2.5 pr-3 text-xs text-white/50">{new Date(invite.expiresAt).toLocaleDateString()}</td>
                        <td className="py-2.5 text-right">
                          <button type="button" disabled={busy} onClick={() => void copyInviteLink(invite)} className="mr-4 text-xs font-bold text-forge-lime hover:underline disabled:opacity-40">
                            {copiedInviteId === invite.id ? "Copied!" : "Copy link"}
                          </button>
                          <button type="button" disabled={busy} onClick={() => void revoke(invite)} className="text-xs font-bold text-forge-rust hover:underline disabled:opacity-40">
                            Revoke
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {expiredInvites.length > 0 && (
              <p className="mt-4 text-xs text-white/40">
                {expiredInvites.length} expired invite{expiredInvites.length === 1 ? "" : "s"} — send a new invite if they still need access.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
