import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDashboardContext } from "@/lib/dashboard-context";
import { RescueDashboardGate } from "@/components/rescue-dashboard-gate";
import { RescueAppointmentsPanel } from "@/components/rescue-appointments-panel";
import { APPOINTMENT_WRITE_ROLES } from "@/lib/roles";

export const metadata: Metadata = { title: "Appointments — Revenue Rescue", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** Provider-neutral appointment tracking with manual booking. */
export default async function AppointmentsPage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const { org: orgParam } = await searchParams;
  const ctx = await getDashboardContext(orgParam, "appointments");
  if (ctx.kind === "unauthenticated") redirect("/login");
  if (ctx.kind !== "ok") return <RescueDashboardGate ctx={ctx} />;

  return (
    <section className="shell py-10">
      <div className="mx-auto max-w-6xl">
        <p className="eyebrow">Revenue Rescue · {ctx.active.name}</p>
        <h1 className="mt-4 font-display text-5xl font-semibold">Appointments</h1>
        <div className="mt-8">
          <RescueAppointmentsPanel orgId={ctx.active.id} canWrite={APPOINTMENT_WRITE_ROLES.includes(ctx.role)} />
        </div>
      </div>
    </section>
  );
}
