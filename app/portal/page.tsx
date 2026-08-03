import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getPortalHostContext } from "@/lib/portal-host";

export const metadata: Metadata = { title: "Client portal", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * Landing target for requests arriving on a custom domain (rewritten here from
 * "/" by proxy.ts). Active domains route to the owning org's portal (dashboard
 * when signed in, branded login otherwise). Hosts that are not an active
 * custom domain get an honest "not connected" page — they never render any
 * org's portal.
 */
export default async function PortalPage() {
  const context = await getPortalHostContext();
  if (context.kind === "platform") redirect("/login");
  if (context.kind === "portal") {
    redirect((await getCurrentUser()) ? "/dashboard/revenue-rescue" : "/login");
  }

  return (
    <section className="shell py-24">
      <div className="mx-auto max-w-md text-center">
        <p className="eyebrow">Domain not connected</p>
        <h1 className="mt-4 font-display text-4xl font-semibold">This domain isn&apos;t serving a portal yet.</h1>
        <p className="mt-6 text-sm leading-6 text-white/50">
          <span className="font-mono text-white/70">{context.host}</span> points here, but it hasn&apos;t completed
          verification and activation. If you own this domain, finish the DNS verification steps in your portal&apos;s
          branding settings and ask your provider to activate it.
        </p>
      </div>
    </section>
  );
}
