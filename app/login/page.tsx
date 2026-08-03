import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { authenticateUser } from "@/lib/accounts";
import { createUserSession, getCurrentUser } from "@/lib/auth";
import { getPortalHostContext } from "@/lib/portal-host";

export const metadata: Metadata = { title: "Sign in", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

async function loginAction(formData: FormData) {
  "use server";
  const result = await authenticateUser(String(formData.get("email") ?? ""), String(formData.get("password") ?? ""));
  if (!result.ok) redirect(`/login?error=${encodeURIComponent(result.error)}`);
  await createUserSession(result.userId);
  // On a client's custom domain the portal IS the dashboard — skip /account.
  const portal = await getPortalHostContext();
  redirect(portal.kind === "portal" ? "/dashboard/revenue-rescue" : "/account");
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const portal = await getPortalHostContext();
  if (await getCurrentUser()) redirect(portal.kind === "portal" ? "/dashboard/revenue-rescue" : "/account");

  // Hosts that are not an active custom domain never render a login form.
  if (portal.kind === "unknown_domain") {
    return (
      <section className="shell py-24">
        <div className="mx-auto max-w-md text-center">
          <p className="eyebrow">Domain not connected</p>
          <h1 className="mt-4 font-display text-4xl font-semibold">This domain isn&apos;t serving a portal yet.</h1>
          <p className="mt-6 text-sm leading-6 text-white/50">
            Finish DNS verification and activation for this domain, then reload this page.
          </p>
        </div>
      </section>
    );
  }

  const { error } = await searchParams;
  const branding = portal.kind === "portal" ? portal.branding : null;
  // Per-org accents must be inline styles (Tailwind colors are compiled hex).
  const accent = branding?.primaryColor ?? null;

  return <section className="shell py-24">
    <div className="mx-auto max-w-sm">
      {branding?.logoUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={branding.logoUrl} alt={`${branding.displayName} logo`} className="mb-6 h-10 w-auto" />
      )}
      <p className="eyebrow" style={accent ? { color: accent } : undefined}>{branding ? branding.displayName : "Client portal"}</p>
      <h1 className="mt-4 font-display text-4xl font-semibold">{branding ? branding.loginTitle : "Sign in"}</h1>
      <form action={loginAction} className="mt-8 space-y-4">
        <input type="email" name="email" required placeholder="Email" autoFocus className="w-full rounded-xl border border-white/10 bg-white/[.04] px-4 py-3 outline-none focus:border-forge-lime/50" />
        <input type="password" name="password" required placeholder="Password" className="w-full rounded-xl border border-white/10 bg-white/[.04] px-4 py-3 outline-none focus:border-forge-lime/50" />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button type="submit" className="btn-primary w-full" style={accent ? { backgroundColor: accent, borderColor: accent } : undefined}>Sign in</button>
      </form>
      {branding ? (
        <p className="mt-6 text-sm text-white/50">
          {branding.supportEmail ? <>Need access? Contact <a href={`mailto:${branding.supportEmail}`} className="hover:underline" style={accent ? { color: accent } : undefined}>{branding.supportEmail}</a>.</> : "Need access? Contact your account manager."}
          {branding.poweredBy.show && <span className="mt-2 block text-xs text-white/35">{branding.poweredBy.label}</span>}
        </p>
      ) : (
        <p className="mt-6 text-sm text-white/50">No account yet? <Link href="/signup" className="text-forge-lime hover:underline">Create one</Link>. Invited to a team? Use the invite link you were sent.</p>
      )}
    </div>
  </section>;
}
