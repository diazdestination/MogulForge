import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { checkPassword, createAdminSession, isPlatformAdmin } from "@/lib/admin-auth";
import { logAudit } from "@/lib/audit";

export const metadata: Metadata = { title: "Admin sign in", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

async function loginAction(formData: FormData) {
  "use server";
  const next = String(formData.get("next") ?? "/admin/organizations");
  const safeNext = next.startsWith("/admin") ? next : "/admin/organizations";
  if (!checkPassword(String(formData.get("password") ?? ""))) redirect(`/admin/login?error=1&next=${encodeURIComponent(safeNext)}`);
  await createAdminSession();
  await logAudit({ actorLabel: "platform-admin (password)", action: "admin.login" });
  redirect(safeNext);
}

export default async function AdminLoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next } = await searchParams;
  if (await isPlatformAdmin()) redirect(next && next.startsWith("/admin") ? next : "/admin/organizations");
  return <section className="shell py-24">
    <div className="mx-auto max-w-sm">
      <p className="eyebrow">MogulForge Admin</p>
      <h1 className="mt-4 font-display text-4xl font-semibold">Platform admin</h1>
      <form action={loginAction} className="mt-8 space-y-4">
        <input type="hidden" name="next" value={next ?? ""} />
        <input type="password" name="password" required placeholder="Admin password" autoFocus className="w-full rounded-xl border border-white/10 bg-white/[.04] px-4 py-3 outline-none focus:border-forge-lime/50" />
        {error && <p className="text-sm text-red-400">Wrong password. Try again.</p>}
        <button type="submit" className="btn-secondary w-full">Sign in</button>
      </form>
      <p className="mt-6 text-xs text-white/40">MogulForge staff with a platform-admin account can also <Link href="/login" className="text-forge-lime hover:underline">sign in with email</Link>.</p>
    </div>
  </section>;
}
