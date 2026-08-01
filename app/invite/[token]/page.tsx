import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { acceptInvite } from "@/lib/accounts";
import { createUserSession } from "@/lib/auth";
import { getInviteByToken, isInviteActive } from "@/lib/tenant";
import { findUserByEmail } from "@/lib/accounts";
import { ROLE_LABELS } from "@/lib/roles";

export const metadata: Metadata = { title: "Accept invite", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

async function acceptAction(formData: FormData) {
  "use server";
  const token = String(formData.get("token") ?? "");
  const result = await acceptInvite({
    token,
    name: String(formData.get("name") ?? ""),
    password: String(formData.get("password") ?? ""),
  });
  if (!result.ok) redirect(`/invite/${encodeURIComponent(token)}?error=${encodeURIComponent(result.error)}`);
  await createUserSession(result.userId);
  redirect("/account");
}

export default async function InvitePage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ error?: string }> }) {
  const { token } = await params;
  const { error } = await searchParams;
  const invite = await getInviteByToken(token);
  if (!invite || !isInviteActive(invite)) {
    return <section className="shell py-24"><div className="mx-auto max-w-md text-center">
      <p className="eyebrow">Invite</p>
      <h1 className="mt-4 font-display text-4xl font-semibold">This invite link isn&rsquo;t valid</h1>
      <p className="mt-4 text-white/60">It may have expired or already been used. Ask your organization admin to send a new one.</p>
    </div></section>;
  }
  const existingUser = await findUserByEmail(invite.email);
  return <section className="shell py-24">
    <div className="mx-auto max-w-md">
      <p className="eyebrow">Invite</p>
      <h1 className="mt-4 font-display text-4xl font-semibold">Join {invite.organizationName}</h1>
      <p className="mt-3 text-sm text-white/60">You&rsquo;ve been invited as <strong className="text-white">{ROLE_LABELS[invite.role]}</strong> ({invite.email}).</p>
      <form action={acceptAction} className="mt-8 space-y-4">
        <input type="hidden" name="token" value={invite.token} />
        {!existingUser && <input type="text" name="name" defaultValue={invite.name ?? ""} required placeholder="Your name" className="w-full rounded-xl border border-white/10 bg-white/[.04] px-4 py-3 outline-none focus:border-forge-lime/50" />}
        <input type="password" name="password" required minLength={existingUser ? 1 : 8} placeholder={existingUser ? "Your account password" : "Choose a password (8+ characters)"} className="w-full rounded-xl border border-white/10 bg-white/[.04] px-4 py-3 outline-none focus:border-forge-lime/50" />
        {existingUser && <p className="text-xs text-white/50">An account already exists for {invite.email} — enter its password to join.</p>}
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button type="submit" className="btn-primary w-full">Accept invite</button>
      </form>
    </div>
  </section>;
}
