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
 *
 * ── Wave 4 — Staleness alarm cron ────────────────────────────────────
 * `runStalenessCheck` (internalAction) runs every 10 min (see crons.ts).
 * For each `active` account whose lastSuccessfulPollAt is > 30 min old:
 *   1. Skip if same account was alerted within the last 60 min (dedup).
 *   2. Send Telegram alert via convex/lib/telegram_convex.ts.
 *   3. Invoke `internal.backup_poll.runBackupPoll` to auto-heal.
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
      (a) => a.mode === "active" && now - (a.lastSuccessfulPollAt ?? 0) > STALE_MS,
    );
    return {
      ok: stale.length === 0,
      staleCount: stale.length,
      checkedAt: now,
    };
  },
});

// ── Wave 4 — Internal helpers for the staleness check ────────────────

/** Returns active accounts whose lastSuccessfulPollAt is older than 30 min. */
export const listStaleAccounts = internalQuery({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("account_state").collect();
    const now = Date.now();
    return accounts
      .filter(
        (a) => a.mode === "active" && now - (a.lastSuccessfulPollAt ?? 0) > STALE_MS,
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
  perAccount: Array<{
    account: string;
    staleMinutes: number;
    deduped: boolean;
    telegramOk?: boolean;
  }>;
}

export const runStalenessCheck = internalAction({
  args: {},
  handler: async (ctx): Promise<StalenessReport> => {
    const now = Date.now();
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

    // 2026-05-20: DISABLED — backup poller writes stripped data, overwrites primary-enriched rows. Re-enable only after backup_poll fix.
    // const backupResult = await ctx.runAction(internal.backup_poll.runBackupPoll, {});
    report.autoHealInvoked = false;

    for (const s of toAlert) {
      const text =
        `*Hygglo poller stale*\n` +
        `Account: \`${s.account}\`\n` +
        `Last poll: ${s.staleMinutes} min ago\n` +
        `Auto-heal: disabled (primary-poller-only mode)`;
      const tg = await sendTelegram(text);
      report.alerted += 1;
      report.perAccount.push({
        account: s.account,
        staleMinutes: s.staleMinutes,
        deduped: false,
        telegramOk: tg.ok,
      });
      await ctx.runMutation(internal.poller_health.recordAlert, {
        account_slug: s.account,
        sent_at: now,
        stale_minutes: s.staleMinutes,
        auto_heal_attempted: false,
        auto_heal_ok: false,
        telegram_ok: tg.ok,
      });
    }

    return report;
  },
});

// ── Wave 4 — Test-only helpers (failover validation) ─────────────────
// internalMutation = not callable from HTTP/clients. These exist for the
// failover test and admin debug; safe to leave in production.

export const test_setStaleAccount = internalMutation({
  args: { account: v.string(), staleMinutes: v.number() },
  handler: async (ctx, { account, staleMinutes }) => {
    const row = await ctx.db
      .query("account_state")
      .withIndex("by_account", (q) => q.eq("account", account))
      .first();
    if (!row) return { ok: false, reason: "not_found" } as const;
    const previousLast = row.lastSuccessfulPollAt;
    await ctx.db.patch(row._id, {
      lastSuccessfulPollAt: Date.now() - staleMinutes * 60_000,
    });
    return { ok: true, previousLast } as const;
  },
});

export const test_restoreAccount = internalMutation({
  args: { account: v.string(), lastSuccessfulPollAt: v.number() },
  handler: async (ctx, { account, lastSuccessfulPollAt }) => {
    const row = await ctx.db
      .query("account_state")
      .withIndex("by_account", (q) => q.eq("account", account))
      .first();
    if (!row) return { ok: false } as const;
    await ctx.db.patch(row._id, { lastSuccessfulPollAt });
    return { ok: true } as const;
  },
});

export const test_clearAlertsForAccount = internalMutation({
  args: { account_slug: v.string(), since: v.number() },
  handler: async (ctx, { account_slug, since }) => {
    const rows = await ctx.db
      .query("poller_alerts")
      .withIndex("by_account_slug", (q) => q.eq("account_slug", account_slug))
      .collect();
    let deleted = 0;
    for (const r of rows) {
      if (r.sent_at >= since) {
        await ctx.db.delete(r._id);
        deleted += 1;
      }
    }
    return { deleted };
  },
});
