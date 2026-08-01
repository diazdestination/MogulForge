import { Suspense } from "react";
import { EmbedAppointments } from "@/components/embed/embed-appointments";

export const dynamic = "force-dynamic";

/** Embeddable appointments module — token-gated, rendered inside a client-site iframe. */
export default function EmbedAppointmentsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-white/50">Loading…</div>}>
      <EmbedAppointments />
    </Suspense>
  );
}
