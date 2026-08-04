import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { verifyBookingToken } from "@/lib/booking-token";
import { getOrganizationById } from "@/lib/tenant";
import { getOrgSettings } from "@/lib/org-settings";
import { PublicBookingForm } from "@/components/public-booking-form";

export const metadata: Metadata = { title: "Book an appointment", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** Public, token-gated booking page — the org's shareable booking link. */
export default async function BookingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const check = verifyBookingToken(token);
  if (!check.ok) notFound();
  const org = await getOrganizationById(check.claims.org);
  if (!org) notFound();
  const settings = await getOrgSettings(org.id);

  return (
    <section className="shell flex min-h-screen items-center justify-center py-16">
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-white/[0.03] p-8">
        <p className="eyebrow">Book an appointment</p>
        <h1 className="mt-3 font-display text-3xl font-semibold">{org.name}</h1>
        <p className="mt-2 text-sm text-white/55">Pick a time that works for you and we&apos;ll confirm your appointment.</p>
        {settings.calendar.calendlyUrl ? (
          <p className="mt-3 text-sm text-white/55">
            Prefer Calendly?{" "}
            <a href={settings.calendar.calendlyUrl} target="_blank" rel="noopener noreferrer" className="text-forge-lime underline">
              Book on our Calendly page
            </a>
          </p>
        ) : null}
        <div className="mt-6">
          <PublicBookingForm token={token} />
        </div>
      </div>
    </section>
  );
}
