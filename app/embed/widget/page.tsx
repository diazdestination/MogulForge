import { Suspense } from "react";
import { EmbedLeadWidget } from "@/components/embed/embed-lead-widget";

export const dynamic = "force-dynamic";

/** Embeddable lead-capture widget — token-gated, rendered inside a client-site iframe. */
export default function EmbedWidgetPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-white/50">Loading…</div>}>
      <EmbedLeadWidget />
    </Suspense>
  );
}
