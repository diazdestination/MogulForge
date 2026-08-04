const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly check; digest itself sends at most weekly
const WEBHOOK_RETRY_INTERVAL_MS = 60 * 1000; // outgoing webhook retries are due-time based

const FOLLOW_UP_INTERVAL_MS = 15 * 60 * 1000; // campaign follow-ups are day-granular; 15min catches quiet-hour ends quickly
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const globalState = globalThis as typeof globalThis & {
    __leadDigestTimer?: ReturnType<typeof setInterval>;
    __webhookRetryTimer?: ReturnType<typeof setInterval>;
    __campaignFollowUpTimer?: ReturnType<typeof setInterval>;
    __calendarSyncTimer?: ReturnType<typeof setInterval>;
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

  if (!globalState.__calendarSyncTimer) {
    const calendarTick = async () => {
      try {
        const { runCalendarSync } = await import("./lib/calendar/sync");
        const result = await runCalendarSync();
        if (result.cancelled || result.rescheduled || result.calendlyImported || result.calendlyCancelled) {
          console.log(`Calendar sync: ${JSON.stringify(result)}`);
        }
      } catch (error) {
        console.error("Calendar sync pass failed", error);
      }
    };
    globalState.__calendarSyncTimer = setInterval(calendarTick, 10 * 60 * 1000);
    globalState.__calendarSyncTimer.unref?.();
    setTimeout(calendarTick, 30_000).unref?.();
  }

  if (!globalState.__webhookRetryTimer) {
    let crmPullRunning = false;
    const retryTick = async () => {
      try {
        const { processDueDeliveries } = await import("./lib/webhooks/outgoing");
        await processDueDeliveries();
      } catch (error) {
        console.error("Outgoing webhook retry pass failed", error);
      }
      // Scheduled CRM pulls piggyback on the same processor; runScheduledCrmPulls
      // itself only pulls connections whose last pull is older than its interval.
      if (!crmPullRunning) {
        crmPullRunning = true;
        try {
          const { runScheduledCrmPulls } = await import("./lib/crm/sync");
          const result = await runScheduledCrmPulls();
          if (result.pulled > 0 || result.failed > 0) {
            console.log(`Scheduled CRM pull pass: ${result.pulled} pulled, ${result.failed} failed`);
          }
        } catch (error) {
          console.error("Scheduled CRM pull pass failed", error);
        } finally {
          crmPullRunning = false;
        }
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
      const { applyDuePendingPlanChanges } = await import("./lib/subscriptions");
      const applied = await applyDuePendingPlanChanges();
      if (applied.length > 0) console.log(`Applied ${applied.length} scheduled plan change${applied.length === 1 ? "" : "s"}`);
    } catch (error) {
      console.error("Scheduled plan change pass failed", error);
    }
    try {
      const { sendDuePendingPlanChangeReminders } = await import("./lib/subscriptions");
      const outcomes = await sendDuePendingPlanChangeReminders();
      const sent = outcomes.filter((o) => o.status === "sent").length;
      if (sent > 0) console.log(`Sent ${sent} scheduled downgrade reminder${sent === 1 ? "" : "s"}`);
    } catch (error) {
      console.error("Plan change reminder pass failed", error);
    }
    try {
      const { runCustomDomainHealthPass } = await import("./lib/custom-domain-health");
      const health = await runCustomDomainHealthPass();
      if (health.failing > 0) console.log(`Custom-domain health pass: ${health.failing}/${health.checked} failing (${health.regressions} new regression${health.regressions === 1 ? "" : "s"}, ${health.alertsSent} alert(s) sent)`);
    } catch (error) {
      console.error("Custom-domain health pass failed", error);
    }
    try {
      const { cleanupOldPushDeliveries } = await import("./lib/crm/deliveries");
      const { succeededDeleted, failedDeleted } = await cleanupOldPushDeliveries();
      if (succeededDeleted > 0 || failedDeleted > 0) {
        console.log(`CRM delivery log cleanup: removed ${succeededDeleted} succeeded, ${failedDeleted} failed row(s)`);
      }
    } catch (error) {
      console.error("CRM delivery log cleanup failed", error);
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
