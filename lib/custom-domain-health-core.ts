/**
 * Custom-domain health monitoring core (dependency-injected, no server imports).
 *
 * A scheduled pass re-runs the same DNS probe the branding page's "Check now"
 * button uses for every verified/active domain that hasn't been checked
 * recently. The probe itself records last_checked_at / last_check_error on the
 * domain row, so failures surface on the branding page and the admin org page
 * without a manual click. When a previously healthy ACTIVE domain starts
 * failing, an admin alert email goes out — the healthy→failing transition
 * itself dedupes repeats (once the error is recorded, later passes see the
 * domain as already failing).
 */

export type MonitoredDomain = {
  id: string;
  organizationId: string;
  organizationName: string;
  domain: string;
  status: string;
  lastCheckError: string | null;
};

export type DomainProbeOutcome = {
  ok: boolean;
  message: string;
} | null;

export type DomainHealthDeps = {
  /** Verified/active domains due for a re-check (throttled by last_checked_at). */
  listMonitoredDomains: () => Promise<MonitoredDomain[]>;
  /** Runs the probe (records last_checked_at/last_check_error itself). */
  checkDomain: (organizationId: string, domainId: string) => Promise<DomainProbeOutcome>;
  /** Sends the admin regression alert email. Should throw on failure. */
  sendAlert: (alert: DomainRegressionAlert) => Promise<void>;
};

export type DomainRegressionAlert = {
  domain: string;
  organizationName: string;
  message: string;
};

export type DomainHealthPassResult = {
  checked: number;
  failing: number;
  /** Active domains that flipped healthy → failing during this pass. */
  regressions: number;
  alertsSent: number;
};

/** Re-check every monitored domain no more often than this. */
export const DOMAIN_CHECK_MIN_INTERVAL_MINUTES = 30;

export function buildDomainRegressionEmail(alert: DomainRegressionAlert): { subject: string; html: string } {
  return {
    subject: `MogulForge: custom domain ${alert.domain} stopped resolving correctly`,
    html: `<p>The custom domain <strong>${alert.domain}</strong> (organization: ${alert.organizationName}) was healthy but just failed its scheduled DNS check.</p>
<p><strong>Details:</strong> ${alert.message}</p>
<p>The domain is still marked active, so client traffic may be failing. Check the client's DNS records (TXT verification + CNAME) on the admin organization page.</p>`,
  };
}

export async function runDomainHealthPass(deps: DomainHealthDeps): Promise<DomainHealthPassResult> {
  const domains = await deps.listMonitoredDomains();
  const result: DomainHealthPassResult = { checked: 0, failing: 0, regressions: 0, alertsSent: 0 };

  for (const domain of domains) {
    let outcome: DomainProbeOutcome;
    try {
      outcome = await deps.checkDomain(domain.organizationId, domain.id);
    } catch (error) {
      // One domain's probe failure must not stop the rest of the pass.
      console.error(`Scheduled domain check failed for ${domain.domain}`, error);
      continue;
    }
    if (!outcome) continue; // domain removed between listing and check
    result.checked++;
    if (outcome.ok) continue;
    result.failing++;

    // Alert only on the healthy→failing transition for live (active) domains.
    const wasHealthy = domain.lastCheckError === null;
    if (!wasHealthy || domain.status !== "active") continue;
    result.regressions++;
    try {
      await deps.sendAlert({ domain: domain.domain, organizationName: domain.organizationName, message: outcome.message });
      result.alertsSent++;
    } catch (error) {
      console.error(`Domain regression alert failed for ${domain.domain}`, error);
    }
  }
  return result;
}
