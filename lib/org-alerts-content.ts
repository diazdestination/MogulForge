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
