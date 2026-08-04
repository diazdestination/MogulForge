import "server-only";
import { getPool } from "@/lib/db";
import {
  getSchedulerHealth,
  maybeSendStaleSchedulerAlert,
  recordCronHeartbeat,
  type QueryFn,
  type SchedulerHealth,
} from "@/lib/cron-heartbeat-core";

export { STALE_AFTER_MINUTES } from "@/lib/cron-heartbeat-core";
export type { SchedulerHealth } from "@/lib/cron-heartbeat-core";

let ensured = false;
async function ensureTables(query: QueryFn) {
  if (ensured) return;
  await query(`CREATE TABLE IF NOT EXISTS cron_heartbeats (
    job text PRIMARY KEY,
    last_success_at timestamptz NOT NULL DEFAULT now()
  )`);
  await query(`CREATE TABLE IF NOT EXISTS cron_alert_state (
    id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_alerted_at timestamptz
  )`);
  ensured = true;
}

function deps() {
  const query: QueryFn = (text, params) => getPool().query(text, params as unknown[]);
  return { query, now: () => new Date(), env: process.env, fetchFn: fetch };
}

/** Records a successful external cron invocation. Never throws. */
export async function recordHeartbeat(job: string): Promise<void> {
  try {
    const d = deps();
    await ensureTables(d.query);
    await recordCronHeartbeat(d, job);
  } catch (error) {
    console.error(`Failed to record cron heartbeat for ${job}`, error);
  }
}

/** Scheduler health for the admin dashboard banner. */
export async function readSchedulerHealth(): Promise<SchedulerHealth> {
  const d = deps();
  await ensureTables(d.query);
  return getSchedulerHealth(d);
}

/** Watchdog: emails platform admins if the scheduler has gone quiet. */
export async function checkSchedulerAndAlert() {
  const d = deps();
  await ensureTables(d.query);
  return maybeSendStaleSchedulerAlert(d);
}
