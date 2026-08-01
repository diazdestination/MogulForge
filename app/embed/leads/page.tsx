import { Suspense } from "react";
import { EmbedLeads } from "@/components/embed/embed-leads";

export const dynamic = "force-dynamic";

/** Embeddable recent-leads module — token-gated, rendered inside a client-site iframe. */
export default function EmbedLeadsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-white/50">Loading…</div>}>
      <EmbedLeads />
    </Suspense>
  );
}
