#!/usr/bin/env node
/**
 * External cron trigger for Revenue Rescue background jobs.
 *
 * Intended to run as a Replit Scheduled Deployment (or any external
 * scheduler) so webhook retries and the weekly lead digest still fire
 * while the autoscale web app is asleep.
 *
 * Env:
 *   CRON_SECRET      (required) bearer token shared with the web app
 *   CRON_TARGET_URL  (optional) base URL of the deployed app;
 *                    defaults to the production deployment.
 *
 * Exits non-zero if any job endpoint fails, so scheduler runs surface errors.
 */

const BASE_URL = (process.env.CRON_TARGET_URL || "https://mogulforge.replit.app").replace(/\/+$/, "");
const SECRET = process.env.CRON_SECRET;

if (!SECRET) {
  console.error("CRON_SECRET is not set; refusing to run.");
  process.exit(1);
}

const JOBS = [
  { name: "webhook-deliveries", path: "/api/cron/webhook-deliveries" },
  { name: "lead-digest", path: "/api/cron/lead-digest" },
  { name: "plan-changes", path: "/api/cron/plan-changes" },
  { name: "calendar-sync", path: "/api/cron/calendar-sync" },
  { name: "domain-health", path: "/api/cron/domain-health" },
];

let failures = 0;
for (const job of JOBS) {
  const url = `${BASE_URL}${job.path}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(60_000),
    });
    const body = await response.text();
    if (response.ok) {
      console.log(`[cron] ${job.name}: HTTP ${response.status} ${body.slice(0, 300)}`);
    } else {
      failures++;
      console.error(`[cron] ${job.name}: HTTP ${response.status} ${body.slice(0, 300)}`);
    }
  } catch (error) {
    failures++;
    console.error(`[cron] ${job.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

process.exit(failures > 0 ? 1 : 0);
