const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly check; digest itself sends at most weekly
const WEBHOOK_RETRY_INTERVAL_MS = 60 * 1000; // outgoing webhook retries are due-time based

const FOLLOW_UP_INTERVAL_MS = 15 * 60 * 1000; // campaign follow-ups are day-granular; 15min catches quiet-hour ends quickly
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const globalState = globalThis as typeof globalThis & {
    __leadDigestTimer?: ReturnType<typeof setInterval>;
    __webhookRetryTimer?: ReturnType<typeof setInterval>;
    __campaignFollowUpTimer?: ReturnType<typeof setInterval>;
  };

  if (!globalState.__campaignFollowUpTimer) {
    let followUpRunning = false;
    const followUpTick = async () => {
      if (followUpRunning) return; // never overlap passes
      followUpRunning = true;
      try {
        const { runFollowUpPass } = await import("./lib/rescue-engage/follow-up-scheduler");
        const result = await runFollowUpPass();
        if (result.followUpsSent > 0 || result.leadsStopped > 0) {
          console.log(`Campaign follow-up pass: ${result.followUpsSent} simulated send(s), ${result.leadsStopped} lead(s) stopped across ${result.campaignsChecked} campaign(s)`);
        }
      } catch (error) {
        console.error("Campaign follow-up pass failed", error);
      } finally {
        followUpRunning = false;
      }
    };
    globalState.__campaignFollowUpTimer = setInterval(followUpTick, FOLLOW_UP_INTERVAL_MS);
    globalState.__campaignFollowUpTimer.unref?.();
    // Initial pass shortly after boot so restarts don't delay overdue follow-ups.
    setTimeout(followUpTick, 20_000).unref?.();
  }

  if (!globalState.__webhookRetryTimer) {
    const retryTick = async () => {
      try {
        const { processDueDeliveries } = await import("./lib/webhooks/outgoing");
        await processDueDeliveries();
      } catch (error) {
        console.error("Outgoing webhook retry pass failed", error);
      }
    };
    globalState.__webhookRetryTimer = setInterval(retryTick, WEBHOOK_RETRY_INTERVAL_MS);
    globalState.__webhookRetryTimer.unref?.();
  }

  if (globalState.__leadDigestTimer) return;

  const tick = async () => {
    try {
      const { runWeeklyLeadDigest } = await import("./lib/lead-digest");
      const result = await runWeeklyLeadDigest();
      if (result.status === "sent") console.log(`Weekly lead digest sent (${result.leadCount} leads)`);
    } catch (error) {
      console.error("Weekly lead digest check failed", error);
    }
    try {
      const { checkSchedulerAndAlert } = await import("./lib/cron-heartbeat");
      const outcome = await checkSchedulerAndAlert();
      if (outcome === "sent") console.log("Stale-scheduler alert email sent to admins");
    } catch (error) {
      console.error("Scheduler heartbeat check failed", error);
    }
    try {
      const { runOrgWeeklyDigests } = await import("./lib/org-alerts");
      const outcomes = await runOrgWeeklyDigests();
      const sent = outcomes.filter((o) => o.status === "sent").length;
      if (sent > 0) console.log(`Weekly org digests sent to ${sent} organization${sent === 1 ? "" : "s"}`);
    } catch (error) {
      console.error("Weekly org digest check failed", error);
    }
  };

  globalState.__leadDigestTimer = setInterval(tick, CHECK_INTERVAL_MS);
  globalState.__leadDigestTimer.unref?.();
  // Run an initial check shortly after boot so restarts don't delay an overdue digest.
  setTimeout(tick, 15_000).unref?.();
}
