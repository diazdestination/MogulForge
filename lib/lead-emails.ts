import "server-only";
import { getPool } from "@/lib/db";
import { SITE_URL } from "@/lib/site";
import { sendLeadEmailsCore, type LeadEmailInput, type EmailAttachment } from "@/lib/lead-emails-core";
import { renderVisibilityPdf } from "@/lib/visibility-pdf";
import type { VisibilityReport } from "@/lib/visibility-schema";

export type { LeadEmailInput };

// Resend caps the whole email at 40MB; stay well under it so headers, HTML,
// and base64 overhead (~33%) never push a send over the limit.
const MAX_PDF_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function attachmentFilename(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").replace(/[^a-zA-Z0-9.-]/g, "");
    if (host) return `AI-Visibility-Report-${host}.pdf`;
  } catch {
    // fall through to the generic name
  }
  return "AI-Visibility-Report.pdf";
}

function makeRenderPdf(lead: LeadEmailInput, report: VisibilityReport): () => Promise<EmailAttachment | null> {
  return async () => {
    const bytes = await renderVisibilityPdf({
      report,
      url: lead.url,
      createdAt: new Date(),
      reportUrl: `${SITE_URL}/ai-visibility/r/${lead.reportId}`,
    });
    if (bytes.byteLength > MAX_PDF_ATTACHMENT_BYTES) {
      console.error(
        `PDF attachment for report ${lead.reportId} is ${bytes.byteLength} bytes (over ${MAX_PDF_ATTACHMENT_BYTES}); sending email without it`,
      );
      return null;
    }
    return { filename: attachmentFilename(lead.url), content: Buffer.from(bytes).toString("base64") };
  };
}

let columnsEnsured = false;
async function ensureSentColumns() {
  if (columnsEnsured) return;
  await getPool().query(
    `ALTER TABLE visibility_reports
       ADD COLUMN IF NOT EXISTS prospect_email_sent_at timestamptz,
       ADD COLUMN IF NOT EXISTS hot_alert_sent_at timestamptz`,
  );
  columnsEnsured = true;
}

/**
 * Sends the prospect their report email and, for hot leads (score below
 * HOT_LEAD_THRESHOLD, default 50), an instant admin alert. Idempotent per
 * report and never throws — email failures are logged loudly and must not
 * break the scan response. Outbound sends carry a strict timeout, so this
 * is bounded even when the email provider hangs.
 */
export async function sendLeadEmails(lead: LeadEmailInput, report?: VisibilityReport): Promise<void> {
  try {
    await ensureSentColumns();
  } catch (error) {
    console.error("Lead emails skipped: failed to ensure sent-tracking columns", error);
    return;
  }
  await sendLeadEmailsCore(lead, {
    query: (sql, params) => getPool().query(sql, params as never),
    fetchFn: fetch,
    env: process.env,
    siteUrl: SITE_URL,
    renderPdf: report ? makeRenderPdf(lead, report) : undefined,
  });
}
