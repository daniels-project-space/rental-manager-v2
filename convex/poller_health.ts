/**
 * Wave 3c — Poller health probe.
 *
 * Public query used by the `/api/health/poller` Vercel route, which is in turn
 * pinged by external uptime monitors (UptimeRobot/Pingdom/etc.) every ~5 min.
 *
 * Returns ONLY aggregate freshness counters — never account names — so it is
 * safe to call from unauthenticated probes.
 *
 * "Stale" = any active or paused account whose `lastSuccessfulPollAt` is
 * older than 30 minutes. A paused account is included so the recovery lane can
 * retry it; `quiet` remains intentionally excluded as off-cadence.
 *
 * ── Wave 4 — Staleness alarm cron ────────────────────────────────────
 * `runStalenessCheck` (internalAction) runs every 20 min (see crons.ts).
 * For each `active` account whose lastSuccessfulPollAt is > 30 min old:
 *   1. Skip if same account was alerted within the last 60 min (dedup).
 *   2. Send Telegram alert via convex/lib/telegram_convex.ts.
 *   3. Enqueue the existing authenticated Vercel/Trigger poll endpoint to
 *      auto-heal the scheduler without an LLM.
 *   4. Insert a row into `poller_alerts`.
 *
 * Test helpers (`test_setStaleAccount`, `test_clearAlertsForAccount`) are
 * internalMutations used by Wave 4 failover validation. They are NOT
 * cron-scheduled and have no callers from production code; safe to keep
 * because internalMutations are only reachable from server-side code.
 */
import { query, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { sendTelegram } from "./lib/telegram_convex";

const STALE_MS = 30 * 60 * 1000;
const DEDUP_MS = 60 * 60 * 1000;

export const checkPollerHealth = query({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("account_state").collect();
    const now = Date.now();
    const stale = accounts.filter(
      (a) => (a.mode === "active" || a.mode === "paused") && now - (a.lastSuccessfulPollAt ?? 0) > STALE_MS,
    );
    return {
      ok: stale.length === 0,
      staleCount: stale.length,
      checkedAt: now,
    };
  },
});

// ── Wave 4 — Internal helpers for the staleness check ────────────────

/** Returns recoverable stale accounts whose last successful poll is older than 30 min. */
export const listStaleAccounts = internalQuery({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("account_state").collect();
    const now = Date.now();
    return accounts
      .filter(
        (a) => (a.mode === "active" || a.mode === "paused") && now - (a.lastSuccessfulPollAt ?? 0) > STALE_MS,
      )
      .map((a) => ({
        account: a.account,
        lastSuccessfulPollAt: a.lastSuccessfulPollAt,
        staleMinutes: Math.floor((now - (a.lastSuccessfulPollAt ?? 0)) / 60000),
      }));
  },
});

/** Returns the timestamp of the most recent alert for an account (or 0). */
export const lastAlertAt = internalQuery({
  args: { account_slug: v.string() },
  handler: async (ctx, { account_slug }) => {
    const row = await ctx.db
      .query("poller_alerts")
      .withIndex("by_account_slug", (q) => q.eq("account_slug", account_slug))
      .order("desc")
      .first();
    return row?.sent_at ?? 0;
  },
});

/** Insert an alert row (called from the staleness internalAction). */
export const recordAlert = internalMutation({
  args: {
    account_slug: v.string(),
    sent_at: v.number(),
    stale_minutes: v.number(),
    auto_heal_attempted: v.boolean(),
    auto_heal_ok: v.optional(v.boolean()),
    telegram_ok: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("poller_alerts", args);
  },
});

// ── Wave 4 — Staleness check entry point (cron-scheduled) ────────────

interface StalenessReport {
  checkedAt: number;
  staleFound: number;
  alerted: number;
  dedupedSkips: number;
  autoHealInvoked: boolean;
  // Set true when the check short-circuits during the overnight idle window
  // (London 23:00–07:00). The poller is intentionally not polling then, so a
  // "stale" reading is expected, not a stall — we skip the scan + alerting.
  skippedOffHours?: boolean;
  perAccount: Array<{
    account: string;
    staleMinutes: number;
    deduped: boolean;
    telegramOk?: boolean;
    recoveryOk?: boolean;
  }>;
}

/**
 * Ask Vercel to enqueue an immediate Trigger poll. This is deliberately a
 * plain authenticated HTTP call: polling is read-only API I/O, not an AI task.
 * The URL and shared secret are Convex deployment secrets so neither reaches
 * the browser or source control.
 */
async function enqueueRecoveryPoll(): Promise<{ ok: boolean; detail?: string }> {
  const url = process.env.POLL_TRIGGER_URL;
  const secret = process.env.POLL_TRIGGER_SECRET;
  if (!url || !secret) {
    return { ok: false, detail: "POLL_TRIGGER_URL or POLL_TRIGGER_SECRET is not configured" };
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (!response.ok) return { ok: false, detail: `poll endpoint returned ${response.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: String(err).slice(0, 240) };
  }
}

// Active polling window in London local time, expressed as minutes-since-
// midnight. Outside [07:00, 23:00) the poller is intentionally idle.
const ACTIVE_WINDOW_START_MIN = 7 * 60; // 07:00
const ACTIVE_WINDOW_END_MIN = 23 * 60; // 23:00

/** Current Europe/London time as minutes-since-midnight (DST-correct via Intl). */
function londonMinutesSinceMidnight(): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hh * 60 + mm;
}

export const runStalenessCheck = internalAction({
  args: {},
  handler: async (ctx): Promise<StalenessReport> => {
    const now = Date.now();

    // Off-hours guard: the poller is intentionally idle overnight, so a stale
    // lastSuccessfulPollAt during London 23:00–07:00 is expected — not a stall.
    // Return a type-correct "skipped" report WITHOUT scanning account_state or
    // inserting alerts. (07:00 = 420 min inclusive, 23:00 = 1380 min exclusive.)
    const londonMin = londonMinutesSinceMidnight();
    if (londonMin < ACTIVE_WINDOW_START_MIN || londonMin >= ACTIVE_WINDOW_END_MIN) {
      return {
        checkedAt: now,
        staleFound: 0,
        alerted: 0,
        dedupedSkips: 0,
        autoHealInvoked: false,
        skippedOffHours: true,
        perAccount: [],
      };
    }

    const stale = await ctx.runQuery(internal.poller_health.listStaleAccounts, {});

    const report: StalenessReport = {
      checkedAt: now,
      staleFound: stale.length,
      alerted: 0,
      dedupedSkips: 0,
      autoHealInvoked: false,
      perAccount: [],
    };

    if (stale.length === 0) return report;

    // Dedup pass first — only invoke backup_poll if at least one fresh alert.
    const toAlert: typeof stale = [];
    for (const s of stale) {
      const last = await ctx.runQuery(internal.poller_health.lastAlertAt, {
        account_slug: s.account,
      });
      if (now - last < DEDUP_MS) {
        report.dedupedSkips += 1;
        report.perAccount.push({
          account: s.account,
          staleMinutes: s.staleMinutes,
          deduped: true,
        });
        continue;
      }
      toAlert.push(s);
    }

    if (toAlert.length === 0) return report;

    // Trigger schedules can silently stop firing. A stale signal therefore
    // invokes the existing manual poll endpoint once per alert batch. This
    // does not scrape or call an LLM inside Convex; it only enqueues the normal
    // read-only poll task.
    const recovery = await enqueueRecoveryPoll();
    report.autoHealInvoked = recovery.ok;

    for (const s of toAlert) {
      const text =
        `*Hygglo poller stale*\n` +
        `Account: \`${s.account}\`\n` +
        `Last poll: ${s.staleMinutes} min ago\n` +
        `Auto-heal: ${recovery.ok ? "immediate poll enqueued" : `failed (${recovery.detail ?? "unknown"})`}`;
      const tg = await sendTelegram(text);
      report.alerted += 1;
      report.perAccount.push({
        account: s.account,
        staleMinutes: s.staleMinutes,
        deduped: false,
        telegramOk: tg.ok,
        recoveryOk: recovery.ok,
      });
      await ctx.runMutation(internal.poller_health.recordAlert, {
        account_slug: s.account,
        sent_at: now,
        stale_minutes: s.staleMinutes,
        auto_heal_attempted: true,
        auto_heal_ok: recovery.ok,
        telegram_ok: tg.ok,
      });
    }

    return report;
  },
});

// Wave 4 failover test helpers (test_setStaleAccount, test_restoreAccount,
// test_clearAlertsForAccount) deleted 2026-05-24. Wave 4 cutover landed
// 2026-05-13 and was validated end-to-end; the helpers were never wired into
// any automated test suite and had zero runtime callers. Restore from git
// history if a future failover incident needs hands-on simulation.
