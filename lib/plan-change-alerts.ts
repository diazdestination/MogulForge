import "server-only";

/**
 * Admin alert for a scheduled plan change that keeps failing at the payment
 * provider. Sent once per pending change after PLAN_CHANGE_FAILURE_ALERT_THRESHOLD
 * consecutive failed apply passes (the claim lives in
 * org_subscriptions.pending_plan_failure_alerted_at, managed by the caller).
 *
 * Delivery reuses the platform-admin alert channel (RESEND_API_KEY +
 * LEAD_DIGEST_TO), same as domain-health regressions. Alerting is optional:
 * when the env isn't configured the send is skipped (the failure still
 * surfaces on the admin subscriptions page and in the audit log).
 */

/** Consecutive failed apply passes before admins are alerted. */
export const PLAN_CHANGE_FAILURE_ALERT_THRESHOLD = 3;

export type PlanChangeFailureAlert = {
  organizationId: string;
  organizationName: string;
  fromPlanId: string;
  toPlanId: string;
  effectiveAt: string;
  billingProvider: string;
  billingNote: string;
  failedAttempts: number;
};

export function buildPlanChangeFailureEmail(alert: PlanChangeFailureAlert): { subject: string; html: string } {
  return {
    subject: `MogulForge: scheduled plan change for ${alert.organizationName} keeps failing at ${alert.billingProvider}`,
    html: `<p>The scheduled plan change for <strong>${alert.organizationName}</strong> (${alert.fromPlanId} &rarr; ${alert.toPlanId}, due ${new Date(alert.effectiveAt).toUTCString()}) has now failed <strong>${alert.failedAttempts} consecutive times</strong> at the payment provider (${alert.billingProvider}).</p>
<p><strong>Last provider response:</strong> ${alert.billingNote}</p>
<p>The client is still on their old plan and the change will keep retrying automatically, but a human should check the provider account. See the admin subscriptions page for the failing orgs list.</p>`,
  };
}

export type PlanChangeAlertSender = (alert: PlanChangeFailureAlert) => Promise<{ sent: boolean; reason?: string }>;

const SEND_TIMEOUT_MS = 10_000;

async function defaultSender(alert: PlanChangeFailureAlert): Promise<{ sent: boolean; reason?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.LEAD_DIGEST_TO;
  if (!apiKey || !to) return { sent: false, reason: "RESEND_API_KEY / LEAD_DIGEST_TO not configured" };
  const from = process.env.LEAD_DIGEST_FROM ?? "MogulForge <onboarding@resend.dev>";
  const { subject, html } = buildPlanChangeFailureEmail(alert);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Resend API error ${response.status}`);
  return { sent: true };
}

let sender: PlanChangeAlertSender = defaultSender;

/** Sends the admin alert. Throws on delivery failure (caller releases the claim). */
export async function sendPlanChangeFailureAlert(alert: PlanChangeFailureAlert): Promise<{ sent: boolean; reason?: string }> {
  return sender(alert);
}

/** Test hook: swap the delivery mechanism in-process. Returns the previous sender. */
export function setPlanChangeAlertSenderForTests(next: PlanChangeAlertSender | null): PlanChangeAlertSender {
  const previous = sender;
  sender = next ?? defaultSender;
  return previous;
}
