import "server-only";
import { getPool } from "@/lib/db";
import { SITE_URL } from "@/lib/site";
import { sendLeadEmailsCore, type LeadEmailInput } from "@/lib/lead-emails-core";

export type { LeadEmailInput };

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
export async function sendLeadEmails(lead: LeadEmailInput): Promise<void> {
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
  });
}
