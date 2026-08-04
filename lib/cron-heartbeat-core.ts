/**
 * Scheduler heartbeat core (dependency-injected, no server imports).
 *
 * Cron routes record a heartbeat on every successful external invocation.
 * The admin dashboard and the in-app watchdog read that heartbeat to warn
 * platform admins when the external scheduler has gone quiet.
 */

export type QueryResult = { rows: Array<Record<string, unknown>>; rowCount: number | null };
export type QueryFn = (text: string, params?: unknown[]) => Promise<QueryResult>;

export type HeartbeatDeps = {
  query: QueryFn;
  now: () => Date;
  env: Record<string, string | undefined>;
  fetchFn: typeof fetch;
};

/** Warn when no external cron hit has been seen for this long. */
export const STALE_AFTER_MINUTES = 30;
/** Minimum gap between repeated stale-scheduler alert emails. */
export const ALERT_COOLDOWN_MINUTES = 6 * 60;

const SEND_TIMEOUT_MS = 10_000;

/** Records a successful external cron invocation for `job`. Never throws. */
export async function recordCronHeartbeat(deps: Pick<HeartbeatDeps, "query">, job: string): Promise<void> {
  try {
    await deps.query(
      `INSERT INTO cron_heartbeats (job, last_success_at) VALUES ($1, now())
       ON CONFLICT (job) DO UPDATE SET last_success_at = now()`,
      [job],
    );
  } catch (error) {
    console.error(`Failed to record cron heartbeat for ${job}`, error);
  }
}

export type SchedulerHealth = {
  /** true once any external cron hit has ever been recorded */
  hasHeartbeat: boolean;
  /** most recent successful hit across all jobs, or null */
  lastSuccessAt: Date | null;
  /** minutes since the last hit (null when never seen) */
  minutesSinceLast: number | null;
  /** true when the scheduler should be considered quiet/broken */
  stale: boolean;
};

/** Reads overall scheduler health. Stale = never seen OR quiet for 30+ minutes. */
export async function getSchedulerHealth(deps: Pick<HeartbeatDeps, "query" | "now">): Promise<SchedulerHealth> {
  const { rows } = await deps.query(`SELECT max(last_success_at) AS last FROM cron_heartbeats`);
  const raw = rows[0]?.last;
  const lastSuccessAt = raw ? new Date(raw as string | Date) : null;
  if (!lastSuccessAt) return { hasHeartbeat: false, lastSuccessAt: null, minutesSinceLast: null, stale: true };
  const minutesSinceLast = Math.floor((deps.now().getTime() - lastSuccessAt.getTime()) / 60_000);
  return { hasHeartbeat: true, lastSuccessAt, minutesSinceLast, stale: minutesSinceLast >= STALE_AFTER_MINUTES };
}

/** Jobs that record heartbeats when hit by the external scheduler. */
export const KNOWN_CRON_JOBS = [
  "webhook-deliveries",
  "lead-digest",
  "domain-health",
  "crm-delivery-cleanup",
  "plan-changes",
  "calendar-sync",
  "site-health",
  "log-cleanup",
] as const;

export type JobHeartbeat = {
  job: string;
  /** last successful external hit for this job, or null when never seen */
  lastSuccessAt: Date | null;
  /** minutes since the last hit (null when never seen) */
  minutesSinceLast: number | null;
  /** true when this specific job is quiet (never seen or 30+ minutes old) */
  stale: boolean;
};

/**
 * Per-job heartbeat status. Known jobs always appear (with null when never
 * recorded); unknown-but-recorded jobs are included too so nothing is hidden.
 */
export async function getJobHeartbeats(deps: Pick<HeartbeatDeps, "query" | "now">): Promise<JobHeartbeat[]> {
  const { rows } = await deps.query(`SELECT job, last_success_at FROM cron_heartbeats`);
  const seen = new Map<string, Date>();
  for (const row of rows) {
    const job = String(row.job);
    const raw = row.last_success_at;
    if (raw) seen.set(job, new Date(raw as string | Date));
  }
  const jobs = [...KNOWN_CRON_JOBS, ...[...seen.keys()].filter((j) => !(KNOWN_CRON_JOBS as readonly string[]).includes(j)).sort()];
  const nowMs = deps.now().getTime();
  return jobs.map((job) => {
    const lastSuccessAt = seen.get(job) ?? null;
    if (!lastSuccessAt) return { job, lastSuccessAt: null, minutesSinceLast: null, stale: true };
    const minutesSinceLast = Math.floor((nowMs - lastSuccessAt.getTime()) / 60_000);
    return { job, lastSuccessAt, minutesSinceLast, stale: minutesSinceLast >= STALE_AFTER_MINUTES };
  });
}

export type StaleAlertOutcome = "sent" | "healthy" | "no-heartbeat-yet" | "cooldown" | "not-configured" | "send-failed";

/**
 * Emails platform admins when the scheduler is stale. Deduped via a DB
 * cooldown claim so concurrent checks (or hourly ticks) don't spam.
 * Only alerts once a heartbeat has been seen before — a fresh install with
 * no scheduler configured yet gets the dashboard banner, not emails.
 */
export async function maybeSendStaleSchedulerAlert(deps: HeartbeatDeps): Promise<StaleAlertOutcome> {
  const health = await getSchedulerHealth(deps);
  if (!health.stale) return "healthy";
  if (!health.hasHeartbeat) return "no-heartbeat-yet";

  const apiKey = deps.env.RESEND_API_KEY;
  const to = deps.env.LEAD_DIGEST_TO;
  if (!apiKey || !to) return "not-configured";

  // Atomic cooldown claim: only the first caller inside the window sends.
  const claim = await deps.query(
    `INSERT INTO cron_alert_state (id, last_alerted_at) VALUES (1, now())
     ON CONFLICT (id) DO UPDATE SET last_alerted_at = now()
     WHERE cron_alert_state.last_alerted_at IS NULL
        OR cron_alert_state.last_alerted_at < now() - ($1 || ' minutes')::interval
     RETURNING id`,
    [String(ALERT_COOLDOWN_MINUTES)],
  );
  if ((claim.rowCount ?? 0) === 0) return "cooldown";

  const from = deps.env.LEAD_DIGEST_FROM ?? "MogulForge <onboarding@resend.dev>";
  const lastSeen = health.lastSuccessAt ? health.lastSuccessAt.toISOString() : "never";
  const subject = "MogulForge: background job scheduler looks stopped";
  const html = `<p>The external cron scheduler has not hit MogulForge's cron endpoints for <strong>${health.minutesSinceLast} minutes</strong> (threshold: ${STALE_AFTER_MINUTES}).</p>
<p>Last successful hit: <strong>${lastSeen}</strong>.</p>
<p>Webhook retries and the weekly lead digest depend on this scheduler. Check that the scheduled deployment running <code>scripts/cron/trigger.mjs</code> still exists and that its CRON_SECRET matches the app's.</p>`;

  try {
    const response = await deps.fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, html }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Resend API error ${response.status}`);
    return "sent";
  } catch (error) {
    console.error("Stale-scheduler alert email failed", error);
    // Release the cooldown claim so a later check can retry.
    await deps
      .query(`UPDATE cron_alert_state SET last_alerted_at = NULL WHERE id = 1`)
      .catch((releaseError) => console.error("Failed to release cron alert cooldown", releaseError));
    return "send-failed";
  }
}
