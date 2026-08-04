/**
 * Tenant alert email content builders. Pure module — no I/O, unit-testable.
 *
 * Every builder returns { subject, html }. Values are HTML-escaped here so
 * callers can pass raw lead/appointment data straight through.
 */

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export type AlertEmail = { subject: string; html: string };

function wrap(title: string, bodyHtml: string, footer: string): string {
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#111827;max-width:640px;">
    <h2 style="margin-bottom:4px;">${escapeHtml(title)}</h2>
    ${bodyHtml}
    <p style="color:#6b7280;font-size:12px;margin-top:16px;">${escapeHtml(footer)}</p>
  </div>`;
}

function detailRows(rows: Array<[string, string]>): string {
  return `<table style="border-collapse:collapse;font-size:14px;">${rows
    .filter(([, v]) => v !== "")
    .map(
      ([k, v]) => `<tr>
        <td style="padding:6px 12px 6px 0;color:#6b7280;white-space:nowrap;vertical-align:top;">${escapeHtml(k)}</td>
        <td style="padding:6px 0;">${escapeHtml(v)}</td>
      </tr>`,
    )
    .join("")}</table>`;
}

export function buildHotLeadAlertEmail(input: {
  orgName: string;
  leadName: string;
  replyBody: string;
  channel: string;
  categoryLabel: string;
}): AlertEmail {
  return {
    subject: `Hot lead: ${input.leadName} replied — contact them now`,
    html: wrap(
      `🔥 Hot lead — ${input.leadName}`,
      `<p style="margin-top:0;color:#374151;">A lead just replied with strong buying intent (${escapeHtml(input.categoryLabel)}). Reach out while they're engaged.</p>
       ${detailRows([
         ["Lead", input.leadName],
         ["Channel", input.channel.toUpperCase()],
         ["Reply", input.replyBody.slice(0, 500)],
       ])}`,
      `Sent by ${input.orgName} lead alerts. Manage notification preferences in Settings.`,
    ),
  };
}

export function buildReplyAlertEmail(input: {
  orgName: string;
  leadName: string;
  replyBody: string;
  channel: string;
  categoryLabel: string;
}): AlertEmail {
  return {
    subject: `New reply from ${input.leadName} (${input.categoryLabel})`,
    html: wrap(
      `New reply — ${input.leadName}`,
      `<p style="margin-top:0;color:#374151;">A lead replied to your outreach.</p>
       ${detailRows([
         ["Lead", input.leadName],
         ["Category", input.categoryLabel],
         ["Channel", input.channel.toUpperCase()],
         ["Reply", input.replyBody.slice(0, 500)],
       ])}`,
      `Sent by ${input.orgName} lead alerts. Manage notification preferences in Settings.`,
    ),
  };
}

export function buildAppointmentAlertEmail(input: {
  orgName: string;
  leadName: string;
  appointmentType: string;
  scheduledStart: string;
  timezone: string | null;
  address: string | null;
  source: string;
}): AlertEmail {
  const when = Number.isNaN(Date.parse(input.scheduledStart))
    ? input.scheduledStart
    : new Date(input.scheduledStart).toUTCString();
  return {
    subject: `Appointment booked: ${input.leadName} — ${input.appointmentType}`,
    html: wrap(
      `📅 Appointment booked — ${input.leadName}`,
      `<p style="margin-top:0;color:#374151;">A new appointment was just booked.</p>
       ${detailRows([
         ["Lead", input.leadName],
         ["Type", input.appointmentType],
         ["When", when + (input.timezone ? ` (${input.timezone})` : " (UTC)")],
         ["Address", input.address ?? ""],
         ["Booked via", input.source],
       ])}`,
      `Sent by ${input.orgName} lead alerts. Manage notification preferences in Settings.`,
    ),
  };
}

export function buildAnalysisHotLeadsEmail(input: {
  orgName: string;
  hotCount: number;
  analyzedCount: number;
}): AlertEmail {
  const plural = input.hotCount === 1 ? "hot opportunity" : "hot opportunities";
  return {
    subject: `Analysis found ${input.hotCount} ${plural}`,
    html: wrap(
      `🔥 ${input.hotCount} ${plural} found`,
      `<p style="margin-top:0;color:#374151;">A lead analysis run just finished and classified ${input.hotCount} of ${input.analyzedCount} analyzed lead${input.analyzedCount === 1 ? "" : "s"} as hot ${input.hotCount === 1 ? "opportunity" : "opportunities"}. Review them in your leads dashboard and reach out while they're warm.</p>`,
      `Sent by ${input.orgName} lead alerts. Manage notification preferences in Settings.`,
    ),
  };
}

export function buildPlanChangeReminderEmail(input: {
  orgName: string;
  currentPlanName: string;
  pendingPlanName: string;
  effectiveAt: Date;
  planPageUrl: string;
}): AlertEmail {
  const when = input.effectiveAt.toUTCString();
  return {
    subject: `Reminder: ${input.orgName} switches to ${input.pendingPlanName} on ${input.effectiveAt.toISOString().slice(0, 10)}`,
    html: wrap(
      `Scheduled plan change — ${input.orgName}`,
      `<p style="margin-top:0;color:#374151;">A plan change you scheduled is about to take effect. Your account will move from <strong>${escapeHtml(input.currentPlanName)}</strong> to <strong>${escapeHtml(input.pendingPlanName)}</strong>, which may reduce your usage limits.</p>
       ${detailRows([
         ["Current plan", input.currentPlanName],
         ["New plan", input.pendingPlanName],
         ["Takes effect", `${when} (UTC)`],
       ])}
       <p style="margin-top:16px;">
         <a href="${escapeHtml(input.planPageUrl)}" style="display:inline-block;background:#111827;color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;font-size:14px;">Review or cancel this change</a>
       </p>
       <p style="color:#6b7280;font-size:13px;">No action is needed if you still want the change — it will apply automatically.</p>`,
      `Sent by ${input.orgName} account alerts. Manage notification preferences in Settings.`,
    ),
  };
}

export function buildCrmConnectionErrorEmail(input: {
  orgName: string;
  connectionName: string;
  providerLabel: string;
  consecutiveFailures: number;
  lastError: string | null;
  integrationsUrl: string;
}): AlertEmail {
  return {
    subject: `CRM connection paused: ${input.connectionName} (${input.providerLabel}) stopped working`,
    html: wrap(
      `⚠️ CRM connection paused — ${input.connectionName}`,
      `<p style="margin-top:0;color:#374151;">Your ${escapeHtml(input.providerLabel)} connection failed ${input.consecutiveFailures} pushes in a row, so automatic lead delivery has been paused. New leads are still being captured, but they are not reaching your CRM until the connection is fixed.</p>
       ${detailRows([
         ["Connection", input.connectionName],
         ["Provider", input.providerLabel],
         ["Consecutive failures", String(input.consecutiveFailures)],
         ["Last error", (input.lastError ?? "").slice(0, 300)],
       ])}
       <p style="margin-top:16px;"><a href="${escapeHtml(input.integrationsUrl)}" style="background:#111827;color:#ffffff;padding:10px 16px;border-radius:6px;text-decoration:none;font-size:14px;">Review the delivery log</a></p>
       <p style="color:#374151;font-size:13px;">Fix the credentials or endpoint on the Integrations page, then retry a failed delivery — one success reactivates the connection automatically.</p>`,
      `Sent by ${input.orgName} alerts. Manage notification preferences in Settings.`,
    ),
  };
}

export function buildCrmConnectionRecoveredEmail(input: {
  orgName: string;
  connectionName: string;
  providerLabel: string;
  integrationsUrl: string;
}): AlertEmail {
  return {
    subject: `CRM connection recovered: ${input.connectionName} (${input.providerLabel}) is delivering again`,
    html: wrap(
      `✅ CRM connection recovered — ${input.connectionName}`,
      `<p style="margin-top:0;color:#374151;">Good news — a lead push to your ${escapeHtml(input.providerLabel)} connection just succeeded, so automatic lead delivery has resumed. No action is needed.</p>
       ${detailRows([
         ["Connection", input.connectionName],
         ["Provider", input.providerLabel],
         ["Status", "Active — delivering leads again"],
       ])}
       <p style="margin-top:16px;"><a href="${escapeHtml(input.integrationsUrl)}" style="background:#111827;color:#ffffff;padding:10px 16px;border-radius:6px;text-decoration:none;font-size:14px;">Review the delivery log</a></p>
       <p style="color:#374151;font-size:13px;">Earlier failed deliveries were not sent automatically — you can retry them from the delivery log on the Integrations page.</p>`,
      `Sent by ${input.orgName} alerts. Manage notification preferences in Settings.`,
    ),
  };
}

export function buildCustomDomainErrorEmail(input: {
  orgName: string;
  domain: string;
  message: string;
  brandingUrl: string;
}): AlertEmail {
  return {
    subject: `Action needed: your custom domain ${input.domain} stopped resolving`,
    html: wrap(
      `⚠️ Custom domain issue — ${input.domain}`,
      `<p style="margin-top:0;color:#374151;">Your custom domain <strong>${escapeHtml(input.domain)}</strong> was working but just failed its scheduled DNS check. Visitors may not be able to reach your branded portal until the DNS record is fixed.</p>
       ${detailRows([
         ["Domain", input.domain],
         ["What's wrong", input.message.slice(0, 500)],
       ])}
       <p style="margin-top:16px;"><a href="${escapeHtml(input.brandingUrl)}" style="background:#111827;color:#ffffff;padding:10px 16px;border-radius:6px;text-decoration:none;font-size:14px;">Review DNS setup on the Branding page</a></p>
       <p style="color:#374151;font-size:13px;">The Branding page shows the exact TXT and CNAME records to set with your DNS provider, and a "Check now" button to re-verify once you've fixed them.</p>`,
      `Sent by ${input.orgName} alerts. Manage notification preferences in Settings.`,
    ),
  };
}

export type OrgDigestStats = {
  newLeads: number;
  repliesReceived: number;
  appointmentsBooked: number;
  hotLeads: number;
  outboundMessages: number;
};

export function digestHasActivity(stats: OrgDigestStats): boolean {
  return Object.values(stats).some((n) => n > 0);
}

export function buildOrgDigestEmail(input: { orgName: string; since: Date; stats: OrgDigestStats }): AlertEmail {
  const s = input.stats;
  const stat = (label: string, value: number) => `<td style="padding:12px 16px;border:1px solid #e5e7eb;text-align:center;">
      <div style="font-size:24px;font-weight:bold;">${value}</div>
      <div style="color:#6b7280;font-size:12px;">${escapeHtml(label)}</div>
    </td>`;
  return {
    subject: `${input.orgName} — weekly activity digest`,
    html: wrap(
      `${input.orgName} — Weekly Digest`,
      `<p style="margin-top:0;color:#6b7280;">Activity since ${escapeHtml(input.since.toUTCString())}.</p>
       <table style="border-collapse:collapse;width:100%;">
         <tr>
           ${stat("New leads", s.newLeads)}
           ${stat("Replies", s.repliesReceived)}
           ${stat("Appointments", s.appointmentsBooked)}
           ${stat("Hot leads", s.hotLeads)}
           ${stat("Messages sent", s.outboundMessages)}
         </tr>
       </table>`,
      `Sent by ${input.orgName} weekly digest. Manage notification preferences in Settings.`,
    ),
  };
}
