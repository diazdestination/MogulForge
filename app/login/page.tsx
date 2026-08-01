import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { authenticateUser } from "@/lib/accounts";
import { createUserSession, getCurrentUser } from "@/lib/auth";

export const metadata: Metadata = { title: "Sign in", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

async function loginAction(formData: FormData) {
  "use server";
  const result = await authenticateUser(String(formData.get("email") ?? ""), String(formData.get("password") ?? ""));
  if (!result.ok) redirect(`/login?error=${encodeURIComponent(result.error)}`);
  await createUserSession(result.userId);
  redirect("/account");
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await getCurrentUser()) redirect("/account");
  const { error } = await searchParams;
  return <section className="shell py-24">
    <div className="mx-auto max-w-sm">
      <p className="eyebrow">Client portal</p>
      <h1 className="mt-4 font-display text-4xl font-semibold">Sign in</h1>
      <form action={loginAction} className="mt-8 space-y-4">
        <input type="email" name="email" required placeholder="Email" autoFocus className="w-full rounded-xl border border-white/10 bg-white/[.04] px-4 py-3 outline-none focus:border-forge-lime/50" />
        <input type="password" name="password" required placeholder="Password" className="w-full rounded-xl border border-white/10 bg-white/[.04] px-4 py-3 outline-none focus:border-forge-lime/50" />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button type="submit" className="btn-primary w-full">Sign in</button>
      </form>
      <p className="mt-6 text-sm text-white/50">No account yet? <Link href="/signup" className="text-forge-lime hover:underline">Create one</Link>. Invited to a team? Use the invite link you were sent.</p>
    </div>
  </section>;
}
