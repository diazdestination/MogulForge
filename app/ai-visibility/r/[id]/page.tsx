import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/db";
import type { VisibilityReport } from "@/lib/visibility-schema";
import { VisibilityReportView } from "@/components/visibility-report";
import Link from "next/link";

export const metadata: Metadata = { title: "AI Visibility Report", description: "A shared AI Visibility report from MogulForge." };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function SharedReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  let row: { url: string; report: VisibilityReport; created_at: Date } | undefined;
  try {
    const { rows } = await getPool().query("SELECT url, report, created_at FROM visibility_reports WHERE id = $1", [id]);
    row = rows[0];
  } catch (error) {
    console.error("Failed to load visibility report", error);
  }
  if (!row) notFound();

  return <section className="shell py-16 sm:py-24">
    <div className="mx-auto max-w-4xl">
      <div className="rounded-[2rem] border border-forge-lime/30 bg-white/[.04] p-7 sm:p-10 print:border-0 print:bg-white print:p-0">
        <VisibilityReportView report={row.report} scannedUrl={row.url} />
        <p className="mt-6 text-xs text-white/35">Scanned {new Date(row.created_at).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })} by MogulForge AI Visibility Scan.</p>
      </div>
      <div className="mt-8 flex flex-wrap gap-3 print:hidden">
        <Link href="/ai-visibility" className="btn-primary">Scan your own site</Link>
        <Link href="/contact" className="btn-secondary">Talk to MogulForge</Link>
      </div>
    </div>
  </section>;
}
