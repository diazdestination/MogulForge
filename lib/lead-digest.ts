import "server-only";
import { getPool } from "@/lib/db";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type DigestResult =
  | { status: "sent"; leadCount: number }
  | { status: "skipped"; reason: string }
  | { status: "not_configured"; reason: string };

interface LeadRow {
  email: string | null;
  url: string | null;
  score: number;
  created_at: string;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function digestHtml(leads: LeadRow[], since: Date) {
  const rows = leads
    .map(
      (lead) => `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${escapeHtml(lead.email ?? "")}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${escapeHtml(lead.url ?? "")}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center;">${lead.score}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${new Date(lead.created_at).toUTCString()}</td>
      </tr>`,
    )
    .join("");
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#111827;max-width:640px;">
    <h2 style="margin-bottom:4px;">MogulForge — Weekly Lead Digest</h2>
    <p style="margin-top:0;color:#6b7280;">${leads.length} new AI Visibility scan lead${leads.length === 1 ? "" : "s"} since ${since.toUTCString()}.</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px;">
      <thead>
        <tr style="background:#f9fafb;text-align:left;">
          <th style="padding:8px 12px;border-bottom:2px solid #e5e7eb;">Email</th>
          <th style="padding:8px 12px;border-bottom:2px solid #e5e7eb;">Website</th>
          <th style="padding:8px 12px;border-bottom:2px solid #e5e7eb;text-align:center;">Score</th>
          <th style="padding:8px 12px;border-bottom:2px solid #e5e7eb;">Date</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="color:#6b7280;font-size:12px;margin-top:16px;">View all leads in the admin dashboard at /admin/leads.</p>
  </div>`;
}

async function sendViaResend(subject: string, html: string) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.LEAD_DIGEST_TO;
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured");
  if (!to) throw new Error("LEAD_DIGEST_TO is not configured");
  const from = process.env.LEAD_DIGEST_FROM ?? "MogulForge Leads <onboarding@resend.dev>";
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Resend API error ${response.status}: ${body}`);
  }
}

/**
 * Sends a digest of leads captured since the last digest. Sends at most once
 * per week and only when there are new leads. Safe to call repeatedly — a row
 * lock prevents concurrent double-sends.
 */
export async function runWeeklyLeadDigest({ force = false }: { force?: boolean } = {}): Promise<DigestResult> {
  if (!process.env.RESEND_API_KEY || !process.env.LEAD_DIGEST_TO) {
    return {
      status: "not_configured",
      reason: "Set RESEND_API_KEY and LEAD_DIGEST_TO to enable the weekly lead digest.",
    };
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `CREATE TABLE IF NOT EXISTS lead_digest_state (
         id integer PRIMARY KEY CHECK (id = 1),
         last_sent_at timestamptz NOT NULL
       )`,
    );
    // Seed the sentinel row (epoch = never sent) so every execution locks the
    // same row — otherwise two concurrent first runs could both proceed and
    // double-send. Concurrent seeders serialize on the insert, then block on
    // the FOR UPDATE lock below.
    await client.query(
      "INSERT INTO lead_digest_state (id, last_sent_at) VALUES (1, to_timestamp(0)) ON CONFLICT (id) DO NOTHING",
    );
    const { rows: stateRows } = await client.query(
      "SELECT last_sent_at FROM lead_digest_state WHERE id = 1 FOR UPDATE",
    );
    const rawLastSentAt: Date = stateRows[0].last_sent_at;
    const lastSentAt: Date | null = rawLastSentAt.getTime() > 0 ? rawLastSentAt : null;
    if (!force && lastSentAt && Date.now() - lastSentAt.getTime() < WEEK_MS) {
      await client.query("ROLLBACK");
      return { status: "skipped", reason: `Digest already sent at ${lastSentAt.toISOString()}` };
    }
    // First run: look back one week so the initial digest isn't the whole history.
    const since = lastSentAt ?? new Date(Date.now() - WEEK_MS);
    const { rows: leads } = await client.query<LeadRow>(
      "SELECT email, url, score, created_at FROM visibility_reports WHERE created_at > $1 ORDER BY created_at DESC",
      [since],
    );
    if (leads.length === 0) {
      await client.query("ROLLBACK");
      return { status: "skipped", reason: "No new leads since the last digest" };
    }
    const subject = `MogulForge: ${leads.length} new AI Visibility lead${leads.length === 1 ? "" : "s"} this week`;
    await sendViaResend(subject, digestHtml(leads, since));
    await client.query(
      `INSERT INTO lead_digest_state (id, last_sent_at) VALUES (1, now())
       ON CONFLICT (id) DO UPDATE SET last_sent_at = now()`,
    );
    await client.query("COMMIT");
    return { status: "sent", leadCount: leads.length };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
