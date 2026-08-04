import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { registerUser } from "@/lib/accounts";
import { createUserSession, getCurrentUser } from "@/lib/auth";

export const metadata: Metadata = { title: "Create account", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

async function signupAction(formData: FormData) {
  "use server";
  const result = await registerUser({
    email: String(formData.get("email") ?? ""),
    name: String(formData.get("name") ?? ""),
    password: String(formData.get("password") ?? ""),
  });
  if (!result.ok) redirect(`/signup?error=${encodeURIComponent(result.error)}`);
  await createUserSession(result.userId);
  // New accounts flow straight into the guided onboarding (skippable/resumable).
  redirect("/onboarding");
}

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await getCurrentUser()) redirect("/account");
  const { error } = await searchParams;
  return <section className="shell py-24">
    <div className="mx-auto max-w-sm">
      <p className="eyebrow">Client portal</p>
      <h1 className="mt-4 font-display text-4xl font-semibold">Create your account</h1>
      <form action={signupAction} className="mt-8 space-y-4">
        <input type="text" name="name" required placeholder="Your name" autoFocus className="w-full rounded-xl border border-white/10 bg-white/[.04] px-4 py-3 outline-none focus:border-forge-lime/50" />
        <input type="email" name="email" required placeholder="Email" className="w-full rounded-xl border border-white/10 bg-white/[.04] px-4 py-3 outline-none focus:border-forge-lime/50" />
        <input type="password" name="password" required minLength={8} placeholder="Password (8+ characters)" className="w-full rounded-xl border border-white/10 bg-white/[.04] px-4 py-3 outline-none focus:border-forge-lime/50" />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button type="submit" className="btn-primary w-full">Create account</button>
      </form>
      <p className="mt-6 text-sm text-white/50">Already have an account? <Link href="/login" className="text-forge-lime hover:underline">Sign in</Link>.</p>
    </div>
  </section>;
}
