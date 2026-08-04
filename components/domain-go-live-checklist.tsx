import { domainGoLiveChecklist, type DomainStatus, type SslStatus } from "@/lib/custom-domain-core";

/** Go-live checklist for a custom domain — shared by the client branding page and the admin org page. */
export function DomainGoLiveChecklist({ domain }: { domain: { status: DomainStatus; sslStatus: SslStatus } }) {
  const steps = domainGoLiveChecklist(domain);
  return (
    <ol className="mt-3 space-y-1.5">
      {steps.map((step) => (
        <li key={step.key} className="flex items-start gap-2 text-xs">
          <span
            aria-hidden
            className={`mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold ${
              step.done ? "border-forge-lime/60 bg-forge-lime/10 text-forge-lime" : "border-white/20 text-white/30"
            }`}
          >
            {step.done ? "✓" : "·"}
          </span>
          <span>
            <span className={step.done ? "text-white/80" : "text-white/50"}>{step.label}</span>
            {step.detail && <span className="ml-1.5 text-amber-300/90">{step.detail}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}
