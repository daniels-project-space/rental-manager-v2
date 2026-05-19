/**
 * Wave 3c — Poller health probe.
 *
 * Public query used by the `/api/health/poller` Vercel route, which is in turn
 * pinged by external uptime monitors (UptimeRobot/Pingdom/etc.) every ~5 min.
 *
 * Returns ONLY aggregate freshness counters — never account names — so it is
 * safe to call from unauthenticated probes.
 *
 * "Stale" = any account with `mode === "active"` whose `lastSuccessfulPollAt`
 * is older than 30 minutes. `quiet` and `paused` accounts are intentionally
 * excluded (off-cadence / known-bad).
 */
import { query } from "./_generated/server";

const STALE_MS = 30 * 60 * 1000;

export const checkPollerHealth = query({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("account_state").collect();
    const now = Date.now();
    const stale = accounts.filter(
      (a) => a.mode === "active" && now - (a.lastSuccessfulPollAt ?? 0) > STALE_MS,
    );
    return {
      ok: stale.length === 0,
      staleCount: stale.length,
      checkedAt: now,
    };
  },
});
