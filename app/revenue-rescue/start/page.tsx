import type { Metadata } from "next";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { RescueIntakeWizard } from "@/components/rescue-intake-wizard";

export const metadata: Metadata = {
  title: "Start Revenue Rescue — Client Intake",
  description: "Set up your Revenue Rescue workspace: company details, lead sources, and your first lead import.",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default async function RevenueRescueStartPage() {
  const user = await getCurrentUser();
  return (
    <section className="shell py-16 sm:py-20">
      <div className="mx-auto max-w-4xl">
        <p className="eyebrow">Revenue Rescue intake</p>
        <h1 className="mt-5 font-display text-5xl font-semibold leading-[.92] sm:text-6xl">Let&rsquo;s set up your lead database.</h1>
        <p className="mt-5 max-w-2xl text-sm leading-7 text-white/55">
          Seven quick steps: your company, where your old leads live, your lead file, column matching, follow-up preferences, data confirmations, and review. Your file is stored privately and processed into a clean, deduplicated lead database.
        </p>
        <div className="mt-10">
          {user ? (
            <RescueIntakeWizard />
          ) : (
            <div className="rounded-[2rem] border border-white/10 bg-white/[.03] p-8 sm:p-12">
              <h2 className="font-display text-3xl font-semibold">Sign in to begin</h2>
              <p className="mt-3 max-w-xl text-sm leading-7 text-white/55">
                The intake wizard creates your private Revenue Rescue workspace, so you&rsquo;ll need an account first. It takes under a minute.
              </p>
              <div className="mt-7 flex flex-col gap-3 sm:flex-row">
                <Link href="/signup" className="btn-primary">Create an account</Link>
                <Link href="/login" className="btn-secondary">I already have one</Link>
              </div>
              <p className="mt-5 text-xs text-white/35">Then come back to /revenue-rescue/start to continue.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
