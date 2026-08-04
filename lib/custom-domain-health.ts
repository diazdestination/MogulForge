import "server-only";
import { getPool } from "./db";
import { checkCustomDomain } from "./custom-domains";
import {
  buildDomainRegressionEmail,
  DOMAIN_CHECK_MIN_INTERVAL_MINUTES,
  runDomainHealthPass,
  type DomainHealthPassResult,
  type MonitoredDomain,
} from "./custom-domain-health-core";

export type { DomainHealthPassResult } from "./custom-domain-health-core";

const SEND_TIMEOUT_MS = 10_000;

/**
 * Scheduled custom-domain health pass: re-runs the "Check now" probe for
 * verified/active domains that haven't been checked recently, and emails
 * platform admins when a previously healthy active domain starts failing.
 * Safe to run from the in-app timer and the external cron route concurrently —
 * the last_checked_at throttle keeps overlapping passes from double-probing.
 */
export async function runCustomDomainHealthPass(): Promise<DomainHealthPassResult> {
  return runDomainHealthPass({
    listMonitoredDomains: async (): Promise<MonitoredDomain[]> => {
      const { rows } = await getPool().query(
        `SELECT d.id, d.organization_id, d.domain, d.status, d.last_check_error, o.name AS organization_name
         FROM custom_domains d
         JOIN organizations o ON o.id = d.organization_id
         WHERE d.status IN ('verified', 'active')
           AND (d.last_checked_at IS NULL OR d.last_checked_at < now() - ($1 || ' minutes')::interval)
         ORDER BY d.last_checked_at ASC NULLS FIRST`,
        [String(DOMAIN_CHECK_MIN_INTERVAL_MINUTES)],
      );
      return rows.map((row) => ({
        id: row.id,
        organizationId: row.organization_id,
        organizationName: row.organization_name,
        domain: row.domain,
        status: row.status,
        lastCheckError: row.last_check_error ?? null,
      }));
    },
    checkDomain: async (organizationId, domainId) => {
      const result = await checkCustomDomain(organizationId, domainId);
      if (!result) return null;
      return { ok: result.domain.lastCheckError === null, message: result.message };
    },
    sendAlert: async (alert) => {
      const apiKey = process.env.RESEND_API_KEY;
      const to = process.env.LEAD_DIGEST_TO;
      if (!apiKey || !to) return; // alerting is optional; the recorded error still surfaces in the UI
      const from = process.env.LEAD_DIGEST_FROM ?? "MogulForge <onboarding@resend.dev>";
      const { subject, html } = buildDomainRegressionEmail(alert);
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to, subject, html }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Resend API error ${response.status}`);
    },
    notifyOrg: async (alert) => {
      const { sendOrgAlert } = await import("./org-alerts");
      const { buildCustomDomainErrorEmail } = await import("./org-alerts-content.ts");
      const { SITE_URL } = await import("./site");
      const result = await sendOrgAlert(
        alert.organizationId,
        "customDomainAlerts",
        buildCustomDomainErrorEmail({
          orgName: alert.organizationName,
          domain: alert.domain,
          message: alert.message,
          brandingUrl: `${SITE_URL}/dashboard/revenue-rescue/branding`,
        }),
      );
      return result.status === "sent";
    },
  });
}
