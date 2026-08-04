/**
 * Pure, dependency-injected core for instant lead-response emails: the
 * prospect gets their report link, and the admin gets an alert when the score
 * is below HOT_LEAD_THRESHOLD (default 50 — low visibility = big improvement
 * opportunity).
 *
 * Idempotent per report: each send atomically claims a *_sent_at column on
 * visibility_reports, so retries never double-send; a failed send releases
 * the claim so a later retry can send. Never throws — every failure is
 * logged loudly and swallowed so the scan response always succeeds.
 *
 * No server-only imports here so node:test can exercise it directly; the
 * thin wrapper in lib/lead-emails.ts wires real deps.
 */

const DEFAULT_HOT_LEAD_THRESHOLD = 50;
const SEND_TIMEOUT_MS = 10_000;

export type Env = Record<string, string | undefined>;

export interface LeadEmailDeps {
  /** Runs a parameterized SQL statement against the app database. */
  query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }>;
  /** fetch-compatible HTTP client (injected so tests can stub Resend). */
  fetchFn: typeof fetch;
  env: Env;
  siteUrl: string;
  /**
   * Optionally renders the branded PDF report for the prospect email as a
   * Resend attachment ({ filename, content: base64 }). Returning null or
   * throwing skips the attachment — the email still sends without it.
   */
  renderPdf?: () => Promise<EmailAttachment | null>;
}

export interface EmailAttachment {
  filename: string;
  /** Base64-encoded file content, per the Resend attachments API. */
  content: string;
}

export interface LeadEmailInput {
  reportId: string;
  email: string;
  url: string;
  score: number;
  summary: string;
}

export function hotLeadThreshold(env: Env): number {
  const raw = Number(env.HOT_LEAD_THRESHOLD);
  return Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw : DEFAULT_HOT_LEAD_THRESHOLD;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const DEFAULT_FROM = "MogulForge <onboarding@resend.dev>";

/**
 * True when a Resend rejection means the sender identity itself is invalid
 * (custom domain not verified yet / from address not allowed) rather than a
 * transient provider problem.
 */
export function isSenderRejection(status: number, body: string): boolean {
  return status === 403 || (status === 422 && /domain|from/i.test(body));
}

async function sendViaResend(
  deps: LeadEmailDeps,
  { to, subject, html, attachments }: { to: string; subject: string; html: string; attachments?: EmailAttachment[] },
) {
  const apiKey = deps.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured");
  const from = deps.env.LEAD_DIGEST_FROM ?? DEFAULT_FROM;
  // No hardcoded fallback: replies go to the from address unless the business
  // explicitly configures LEAD_DIGEST_REPLY_TO.
  const replyTo = deps.env.LEAD_DIGEST_REPLY_TO;
  const post = (fromAddress: string) =>
    deps.fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: fromAddress,
        to,
        subject,
        html,
        ...(replyTo ? { reply_to: replyTo } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      }),
      // Strict timeout so a slow email provider can never stall the scan response.
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  let response = await post(from);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    // Branded sender rejected (e.g. custom domain not verified yet): fall back
    // to the known-good default sender so the lead email still goes out.
    if (from !== DEFAULT_FROM && isSenderRejection(response.status, body)) {
      console.error(
        `Resend rejected branded sender "${from}" (${response.status}: ${body}); falling back to ${DEFAULT_FROM}`,
      );
      response = await post(DEFAULT_FROM);
      if (response.ok) return;
      const fallbackBody = await response.text().catch(() => "");
      throw new Error(`Resend API error ${response.status}: ${fallbackBody}`);
    }
    throw new Error(`Resend API error ${response.status}: ${body}`);
  }
}

type SentColumn = "prospect_email_sent_at" | "hot_alert_sent_at";

/**
 * Atomically claims a send slot for a report. Returns true only for the first
 * caller; concurrent or repeated calls see the column already set and skip.
 */
async function claimSend(deps: LeadEmailDeps, reportId: string, column: SentColumn): Promise<boolean> {
  const { rowCount } = await deps.query(
    `UPDATE visibility_reports SET ${column} = now() WHERE id = $1 AND ${column} IS NULL`,
    [reportId],
  );
  return (rowCount ?? 0) > 0;
}

/** Releases a claimed slot after a failed send so a later retry can send. */
async function releaseClaim(deps: LeadEmailDeps, reportId: string, column: SentColumn) {
  await deps
    .query(`UPDATE visibility_reports SET ${column} = NULL WHERE id = $1`, [reportId])
    .catch((error) => console.error(`Failed to release ${column} claim for report ${reportId}`, error));
}

function scoreColor(env: Env, score: number): string {
  if (score >= 70) return "#16a34a";
  if (score >= hotLeadThreshold(env)) return "#e36c3d";
  return "#dc2626";
}

// Brand colors (static build-time values, mirrored from lib/site.ts BRAND).
const INK = "#090d0c";
const CREAM = "#f3f0e8";
const LIME = "#c9f75d";
const MOSS = "#23332b";

function prospectHtml(deps: LeadEmailDeps, lead: LeadEmailInput, reportUrl: string) {
  const host = escapeHtml(hostOf(lead.url));
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:${INK};max-width:600px;margin:0 auto;">
    <div style="background:${INK};padding:28px 32px;border-radius:12px 12px 0 0;">
      <p style="margin:0;color:${LIME};font-size:13px;letter-spacing:2px;text-transform:uppercase;">MogulForge</p>
      <h1 style="margin:8px 0 0;color:${CREAM};font-size:22px;">Your AI Visibility Report is ready</h1>
    </div>
    <div style="background:#ffffff;border:1px solid #e5e7eb;border-top:0;padding:28px 32px;border-radius:0 0 12px 12px;">
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Here's how <strong>${host}</strong> shows up when AI assistants like ChatGPT decide which businesses to recommend.</p>
      <div style="text-align:center;margin:24px 0;">
        <div style="display:inline-block;padding:16px 32px;border-radius:12px;background:#f9fafb;border:1px solid #e5e7eb;">
          <div style="font-size:44px;font-weight:bold;color:${scoreColor(deps.env, lead.score)};line-height:1;">${lead.score}</div>
          <div style="font-size:12px;color:#6b7280;margin-top:6px;letter-spacing:1px;text-transform:uppercase;">AI Visibility Score / 100</div>
        </div>
      </div>
      <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#374151;">${escapeHtml(lead.summary)}</p>
      <div style="text-align:center;margin:0 0 24px;">
        <a href="${reportUrl}" style="display:inline-block;background:${LIME};color:${INK};font-weight:bold;font-size:15px;padding:14px 28px;border-radius:8px;text-decoration:none;">View your full report</a>
      </div>
      <div style="border-top:1px solid #e5e7eb;padding-top:20px;">
        <p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#374151;"><strong>Every point below 100 is revenue leaking to competitors AI recommends instead of you.</strong> Our AI Revenue Rescue™ finds those leaks and installs the systems that recover them.</p>
        <a href="${deps.siteUrl}/#book" style="display:inline-block;background:${MOSS};color:${CREAM};font-weight:bold;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none;">Book a free strategy call</a>
      </div>
    </div>
    <p style="color:#9ca3af;font-size:12px;text-align:center;margin-top:16px;">You received this because you ran a free AI Visibility scan at MogulForge.</p>
  </div>`;
}

function hotLeadHtml(deps: LeadEmailDeps, lead: LeadEmailInput, reportUrl: string) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#111827;max-width:600px;">
    <h2 style="margin-bottom:4px;">🔥 Hot lead: ${escapeHtml(hostOf(lead.url))} scored ${lead.score}</h2>
    <p style="margin-top:0;color:#6b7280;">Score below ${hotLeadThreshold(deps.env)} — big improvement opportunity. Respond fast.</p>
    <table style="border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:6px 12px 6px 0;color:#6b7280;">Email</td><td style="padding:6px 0;"><a href="mailto:${escapeHtml(lead.email)}">${escapeHtml(lead.email)}</a></td></tr>
      <tr><td style="padding:6px 12px 6px 0;color:#6b7280;">Website</td><td style="padding:6px 0;">${escapeHtml(lead.url)}</td></tr>
      <tr><td style="padding:6px 12px 6px 0;color:#6b7280;">Score</td><td style="padding:6px 0;font-weight:bold;">${lead.score} / 100</td></tr>
      <tr><td style="padding:6px 12px 6px 0;color:#6b7280;">Report</td><td style="padding:6px 0;"><a href="${reportUrl}">${reportUrl}</a></td></tr>
    </table>
    <p style="color:#6b7280;font-size:12px;margin-top:16px;">All leads: ${deps.siteUrl}/admin/leads</p>
  </div>`;
}

/**
 * Sends the prospect their report and, for hot leads, alerts the admin.
 * Never throws.
 */
export async function sendLeadEmailsCore(lead: LeadEmailInput, deps: LeadEmailDeps): Promise<void> {
  if (!deps.env.RESEND_API_KEY) {
    console.error("Lead emails skipped: RESEND_API_KEY is not configured");
    return;
  }
  const reportUrl = `${deps.siteUrl}/ai-visibility/r/${lead.reportId}`;

  // Render the branded PDF attachment best-effort: any failure is logged and
  // the prospect email still sends without it.
  let attachments: EmailAttachment[] | undefined;
  if (deps.renderPdf) {
    try {
      const attachment = await deps.renderPdf();
      if (attachment) attachments = [attachment];
    } catch (error) {
      console.error(`Failed to render PDF attachment for report ${lead.reportId}; sending email without it`, error);
    }
  }

  try {
    if (await claimSend(deps, lead.reportId, "prospect_email_sent_at")) {
      try {
        await sendViaResend(deps, {
          to: lead.email,
          subject: `Your AI Visibility Score: ${lead.score}/100 — full report inside`,
          html: prospectHtml(deps, lead, reportUrl),
          attachments,
        });
      } catch (error) {
        console.error(`Failed to send prospect report email for report ${lead.reportId}`, error);
        await releaseClaim(deps, lead.reportId, "prospect_email_sent_at");
      }
    }
  } catch (error) {
    console.error(`Prospect email claim failed for report ${lead.reportId}`, error);
  }

  if (lead.score >= hotLeadThreshold(deps.env)) return;
  const adminTo = deps.env.LEAD_DIGEST_TO;
  if (!adminTo) {
    console.error("Hot lead alert skipped: LEAD_DIGEST_TO is not configured");
    return;
  }
  try {
    if (await claimSend(deps, lead.reportId, "hot_alert_sent_at")) {
      try {
        await sendViaResend(deps, {
          to: adminTo,
          subject: `🔥 Hot lead: ${hostOf(lead.url)} scored ${lead.score}/100`,
          html: hotLeadHtml(deps, lead, reportUrl),
        });
      } catch (error) {
        console.error(`Failed to send hot lead alert for report ${lead.reportId}`, error);
        await releaseClaim(deps, lead.reportId, "hot_alert_sent_at");
      }
    }
  } catch (error) {
    console.error(`Hot lead alert claim failed for report ${lead.reportId}`, error);
  }
}
