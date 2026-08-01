import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getVisibilityReport, reportHost } from "@/lib/report-lookup";
import { VisibilityReportView } from "@/components/visibility-report";
import Link from "next/link";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const row = await getVisibilityReport(id);
  if (!row) return { title: "AI Visibility Report", description: "A shared AI Visibility report from MogulForge." };
  const host = reportHost(row.url);
  const title = `AI Visibility Score: ${row.score}/100 — ${host}`;
  const description = `See how visible ${host} is to AI search engines — schema, crawlability, metadata, and content structure, scored by MogulForge.`;
  return { title, description, openGraph: { title, description }, twitter: { title, description } };
}

export default async function SharedReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const row = await getVisibilityReport(id);
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
