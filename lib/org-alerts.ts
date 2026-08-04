import "server-only";
import { getPool } from "./db";
import { getOrgSettings } from "./org-settings.ts";
import type { NotificationSettings } from "./org-settings-schema.ts";
import { buildOrgDigestEmail, digestHasActivity, type AlertEmail, type OrgDigestStats } from "./org-alerts-content.ts";

/**
 * Tenant-facing alert delivery honoring per-org notification settings
 * (Settings → Notifications). Every send checks the matching toggle AND
 * requires at least one saved notification address — there is deliberately
 * no fallback recipient: orgs that saved no addresses receive nothing.
 *
 * Uses the same Resend account as the platform lead digest. These are
 * alerts to the org's own team (who configured the addresses themselves),
 * not outreach to prospects, so the shared sender is acceptable.
 */

export type OrgAlertKind = Exclude<keyof NotificationSettings, "notificationEmails">;

export type OrgAlertResult =
  | { status: "sent"; to: string[] }
  | { status: "skipped"; reason: "toggle_off" | "no_recipients" | "not_configured" };

async function sendViaResend(to: string[], email: AlertEmail): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured");
  const from = process.env.ORG_ALERTS_FROM ?? process.env.LEAD_DIGEST_FROM ?? "MogulForge Alerts <onboarding@resend.dev>";
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject: email.subject, html: email.html }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Resend API error ${response.status}: ${body}`);
  }
}

/**
 * Sends an alert to the org's saved notification addresses when the matching
 * toggle is enabled. Never throws on preference-based skips; throws only on
 * actual delivery failures (caller decides whether that is fatal).
 */
export async function sendOrgAlert(organizationId: string, kind: OrgAlertKind, email: AlertEmail): Promise<OrgAlertResult> {
  if (!process.env.RESEND_API_KEY) return { status: "skipped", reason: "not_configured" };
  const settings = await getOrgSettings(organizationId);
  if (!settings.notifications[kind]) return { status: "skipped", reason: "toggle_off" };
  const to = settings.notifications.notificationEmails;
  if (to.length === 0) return { status: "skipped", reason: "no_recipients" };
  await sendViaResend(to, email);
  return { status: "sent", to };
}

/**
 * Fire-and-forget variant for request hot paths (reply processing, appointment
 * booking). A failed alert email must never fail the underlying operation.
 */
export function sendOrgAlertInBackground(organizationId: string, kind: OrgAlertKind, email: AlertEmail): void {
  sendOrgAlert(organizationId, kind, email).catch((error) => {
    console.error(`Org alert (${kind}) failed for organization ${organizationId}`, error);
  });
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type OrgDigestOutcome = { organizationId: string; status: "sent" | "skipped"; reason?: string };

async function collectDigestStats(organizationId: string, since: Date): Promise<OrgDigestStats> {
  const pool = getPool();
  const params = [organizationId, since];
  const [leads, replies, appts, hot, outbound] = await Promise.all([
    pool.query("SELECT count(*)::int AS n FROM rescue_leads WHERE organization_id = $1 AND created_at > $2", params),
    pool.query(
      "SELECT count(*)::int AS n FROM rescue_messages WHERE organization_id = $1 AND direction = 'inbound' AND created_at > $2",
      params,
    ),
    pool.query("SELECT count(*)::int AS n FROM rescue_appointments WHERE organization_id = $1 AND created_at > $2", params),
    pool.query(
      `SELECT count(*)::int AS n FROM rescue_leads
       WHERE organization_id = $1 AND suppressed = false
         AND pipeline_stage NOT IN ('won', 'lost', 'suppressed')
         AND (category = 'hot_opportunity' OR score >= 70)`,
      [organizationId],
    ),
    pool.query(
      "SELECT count(*)::int AS n FROM rescue_messages WHERE organization_id = $1 AND direction = 'outbound' AND created_at > $2",
      params,
    ),
  ]);
  return {
    newLeads: leads.rows[0].n,
    repliesReceived: replies.rows[0].n,
    appointmentsBooked: appts.rows[0].n,
    hotLeads: hot.rows[0].n,
    outboundMessages: outbound.rows[0].n,
  };
}

/**
 * Sends the weekly activity digest to every org that enabled it and saved at
 * least one notification address. Per-org row locks in org_digest_state make
 * this safe to call repeatedly (hourly timer + manual cron) — each org gets at
 * most one digest per week. Safe to run with zero eligible orgs.
 */
export async function runOrgWeeklyDigests({ force = false }: { force?: boolean } = {}): Promise<OrgDigestOutcome[]> {
  if (!process.env.RESEND_API_KEY) return [];
  const pool = getPool();
  await pool.query(
    `CREATE TABLE IF NOT EXISTS org_digest_state (
       organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
       last_sent_at timestamptz NOT NULL
     )`,
  );
  // Candidate orgs by stored settings; toggle + emails are re-validated
  // through normalizeOrgSettings inside sendOrgAlert before any send.
  const { rows: candidates } = await pool.query(
    `SELECT id, name FROM organizations
     WHERE (settings->'notifications'->>'weeklyDigest')::boolean IS TRUE
       AND jsonb_array_length(COALESCE(settings->'notifications'->'notificationEmails', '[]'::jsonb)) > 0`,
  );

  const outcomes: OrgDigestOutcome[] = [];
  for (const org of candidates) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO org_digest_state (organization_id, last_sent_at) VALUES ($1, to_timestamp(0)) ON CONFLICT (organization_id) DO NOTHING",
        [org.id],
      );
      const { rows: stateRows } = await client.query(
        "SELECT last_sent_at FROM org_digest_state WHERE organization_id = $1 FOR UPDATE",
        [org.id],
      );
      const rawLast: Date = stateRows[0].last_sent_at;
      const lastSentAt: Date | null = rawLast.getTime() > 0 ? rawLast : null;
      if (!force && lastSentAt && Date.now() - lastSentAt.getTime() < WEEK_MS) {
        await client.query("ROLLBACK");
        outcomes.push({ organizationId: org.id, status: "skipped", reason: "already_sent_this_week" });
        continue;
      }
      const since = lastSentAt ?? new Date(Date.now() - WEEK_MS);
      const stats = await collectDigestStats(org.id, since);
      if (!digestHasActivity(stats)) {
        await client.query("ROLLBACK");
        outcomes.push({ organizationId: org.id, status: "skipped", reason: "no_activity" });
        continue;
      }
      const result = await sendOrgAlert(org.id, "weeklyDigest", buildOrgDigestEmail({ orgName: org.name, since, stats }));
      if (result.status !== "sent") {
        await client.query("ROLLBACK");
        outcomes.push({ organizationId: org.id, status: "skipped", reason: result.reason });
        continue;
      }
      await client.query(
        `INSERT INTO org_digest_state (organization_id, last_sent_at) VALUES ($1, now())
         ON CONFLICT (organization_id) DO UPDATE SET last_sent_at = now()`,
        [org.id],
      );
      await client.query("COMMIT");
      outcomes.push({ organizationId: org.id, status: "sent" });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      console.error(`Weekly org digest failed for organization ${org.id}`, error);
      outcomes.push({ organizationId: org.id, status: "skipped", reason: "error" });
    } finally {
      client.release();
    }
  }
  return outcomes;
}
