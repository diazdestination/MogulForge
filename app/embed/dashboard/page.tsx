import { Suspense } from "react";
import { EmbedDashboard } from "@/components/embed/embed-dashboard";

export const dynamic = "force-dynamic";

/** Embeddable dashboard module — token-gated, rendered inside a client-site iframe. */
export default function EmbedDashboardPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-white/50">Loading…</div>}>
      <EmbedDashboard />
    </Suspense>
  );
}
