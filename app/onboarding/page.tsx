import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { findManagedOrganization, getOnboardingRecord, getOnboardingStatus } from "@/lib/onboarding";
import { OnboardingWizard } from "@/components/onboarding-wizard";

export const metadata: Metadata = { title: "Get set up — MogulForge", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * Guided onboarding: company basics → connect Google → bring your leads →
 * connect your website → honest status summary. Every step is skippable and
 * the flow resumes wherever the user left off.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string; calendar?: string; reason?: string; revisit?: string; org?: string }>;
}) {
  const sp = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const org = await findManagedOrganization(user.id, sp.org ?? null);
  let record = null;
  let status = null;
  if (org) {
    [record, status] = await Promise.all([getOnboardingRecord(org.id), getOnboardingStatus(org.id)]);
    // Finished orgs go straight to the dashboard unless they explicitly revisit
    // (or are mid-OAuth-callback / deep-linked to a step).
    if (record.completedAt && sp.revisit !== "1" && !sp.calendar && !sp.step) {
      redirect(`/dashboard/revenue-rescue?org=${org.id}`);
    }
  }

  return (
    <section className="shell py-12">
      <div className="mx-auto max-w-3xl">
        <OnboardingWizard
          userName={user.name}
          org={org ? { ...org, website: status?.website.websiteUrl ?? "" } : null}
          initialRecord={record}
          initialStatus={status}
          feedback={{ calendar: sp.calendar ?? null, reason: sp.reason ?? null }}
          requestedStep={sp.step ?? null}
        />
      </div>
    </section>
  );
}
