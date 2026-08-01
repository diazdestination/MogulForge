const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly check; digest itself sends at most weekly

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const globalState = globalThis as typeof globalThis & { __leadDigestTimer?: ReturnType<typeof setInterval> };
  if (globalState.__leadDigestTimer) return;

  const tick = async () => {
    try {
      const { runWeeklyLeadDigest } = await import("./lib/lead-digest");
      const result = await runWeeklyLeadDigest();
      if (result.status === "sent") console.log(`Weekly lead digest sent (${result.leadCount} leads)`);
    } catch (error) {
      console.error("Weekly lead digest check failed", error);
    }
  };

  globalState.__leadDigestTimer = setInterval(tick, CHECK_INTERVAL_MS);
  globalState.__leadDigestTimer.unref?.();
  // Run an initial check shortly after boot so restarts don't delay an overdue digest.
  setTimeout(tick, 15_000).unref?.();
}
