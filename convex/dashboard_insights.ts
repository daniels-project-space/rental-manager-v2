// Phase 7 — Dashboard insight widgets that consume weekly_metrics rollup.
// Five small read queries — no recomputation, just aggregations over Phase 5's table.

import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { isPaid } from "./order_step_semantics";

// ── Helpers ───────────────────────────────────────────────────────────

/** YYYY-MM-DD `days` days ago, in UTC. */
function isoDaysAgo(days: number): string {
  const now = Date.now();
  const d = new Date(now - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

type Row = Doc<"weekly_metrics">;

/**
 * Fetch all weekly_metrics rows for an account+granularity over the
 * trailing `days` window.
 *
 * Uses the `by_week_account_granularity` index then filters by start.
 * When accountSlug is null we pull both real accounts (`gungoid`, `gungoid-2`)
 * and sum.
 */
async function fetchWindow(
  ctx: { db: { query: any } },
  args: { accountSlug: string | null; days: number; granularity: "global" | "item" | "kind" },
): Promise<Row[]> {
  const cutoff = isoDaysAgo(args.days);

  // weekly_metrics is small (< few thousand rows). Scan + filter in-memory.
  // The composite index `by_week_account_granularity` requires a leading
  // week_start; since we want an open-ended window we just scan.
  const all = (await ctx.db.query("weekly_metrics").collect()) as Row[];
  return all.filter(
    (r) =>
      r.granularity === args.granularity &&
      r.week_start >= cutoff &&
      (args.accountSlug === null || r.account_slug === args.accountSlug),
  );
}

// ── 1. Voluntary Deny Hot List ────────────────────────────────────────

export const getVoluntaryDenyHotList = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    days: v.optional(v.number()),
  },
  handler: async (ctx, { accountSlug, days = 90 }) => {
    const rows = await fetchWindow(ctx, { accountSlug, days, granularity: "item" });
    const agg = new Map<string, { item_id: Id<"items">; name: string; count: number; gbp: number }>();
    for (const r of rows) {
      const c = r.voluntary_denied_count ?? 0;
      const g = r.voluntary_denied_estimated_gbp ?? 0;
      if (c === 0 && g === 0) continue;
      if (!r.item_id) continue;
      const key = r.item_id as string;
      const cur = agg.get(key);
      if (cur) {
        cur.count += c;
        cur.gbp += g;
      } else {
        agg.set(key, {
          item_id: r.item_id,
          name: r.item_name_canonical ?? "(unknown)",
          count: c,
          gbp: g,
        });
      }
    }
    return Array.from(agg.values())
      .sort((a, b) => b.gbp - a.gbp)
      .slice(0, 5);
  },
});

// ── 2. Capacity Gap Alert ─────────────────────────────────────────────

export const getCapacityGapAlert = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    days: v.optional(v.number()),
  },
  handler: async (ctx, { accountSlug, days = 90 }) => {
    const rows = await fetchWindow(ctx, { accountSlug, days, granularity: "item" });
    const agg = new Map<string, { item_id: Id<"items">; name: string; count: number; gbp: number }>();
    for (const r of rows) {
      const c = r.capacity_denied_count ?? 0;
      const g = r.capacity_denied_estimated_gbp ?? 0;
      if (c === 0 && g === 0) continue;
      if (!r.item_id) continue;
      const key = r.item_id as string;
      const cur = agg.get(key);
      if (cur) {
        cur.count += c;
        cur.gbp += g;
      } else {
        agg.set(key, {
          item_id: r.item_id,
          name: r.item_name_canonical ?? "(unknown)",
          count: c,
          gbp: g,
        });
      }
    }
    return Array.from(agg.values())
      .sort((a, b) => b.gbp - a.gbp)
      .slice(0, 5);
  },
});

// ── 3. Item Utilization Ranking ───────────────────────────────────────
// Most idle high-value: replacement_cost × (1 - utilization_rate).
// Average utilization over last 4 weeks.

export const getItemUtilizationRanking = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    weeks: v.optional(v.number()),
  },
  handler: async (ctx, { accountSlug, weeks = 4 }) => {
    const days = weeks * 7;
    const rows = await fetchWindow(ctx, { accountSlug, days, granularity: "item" });
    const agg = new Map<string, { item_id: Id<"items">; name: string; util_sum: number; util_n: number }>();
    for (const r of rows) {
      if (!r.item_id) continue;
      const u = r.utilization_rate;
      if (u === undefined || u === null) continue;
      const key = r.item_id as string;
      const cur = agg.get(key);
      if (cur) {
        cur.util_sum += u;
        cur.util_n += 1;
      } else {
        agg.set(key, {
          item_id: r.item_id,
          name: r.item_name_canonical ?? "(unknown)",
          util_sum: u,
          util_n: 1,
        });
      }
    }
    // Need replacement_cost_gbp from items table.
    const out: Array<{
      item_id: Id<"items">;
      name: string;
      utilization: number;
      replacement_cost_gbp: number;
      idle_cost_per_week: number;
    }> = [];
    for (const v of agg.values()) {
      const item = await ctx.db.get(v.item_id);
      if (!item) continue;
      const cost = item.replacement_cost_gbp ?? 0;
      if (cost === 0) continue;
      const util = v.util_sum / v.util_n;
      const idle = cost * (1 - util);
      // Crude weekly idle £ proxy: replacement cost × idle ratio × (1/52)
      // — keeps units sensible (~weekly opportunity cost).
      const idle_per_week = idle / 52;
      out.push({
        item_id: v.item_id,
        name: v.name || item.name_canonical,
        utilization: util,
        replacement_cost_gbp: cost,
        idle_cost_per_week: idle_per_week,
      });
    }
    return out.sort((a, b) => b.idle_cost_per_week - a.idle_cost_per_week).slice(0, 5);
  },
});

// ── 4. Below-Minimum Threshold Counter ────────────────────────────────

export const getBelowMinimumCounter = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    days: v.optional(v.number()),
  },
  handler: async (ctx, { accountSlug, days = 90 }) => {
    const rows = await fetchWindow(ctx, { accountSlug, days, granularity: "global" });
    let count = 0;
    let gbp = 0;
    for (const r of rows) {
      count += r.below_minimum_threshold_denied_count ?? 0;
      gbp += r.below_minimum_threshold_denied_estimated_gbp ?? 0;
    }
    return { count, gbp, days };
  },
});

// ── 5. Weekly Revenue Sparkline ───────────────────────────────────────

export const getWeeklyRevenueSparkline = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    weeks: v.optional(v.number()),
  },
  handler: async (ctx, { accountSlug, weeks = 8 }) => {
    const days = weeks * 7 + 7; // slight pad for boundary weeks
    const rows = await fetchWindow(ctx, { accountSlug, days, granularity: "global" });
    // Group by week_start. When accountSlug is null we sum both accounts.
    const byWeek = new Map<string, { gross: number; attributed: number; net: number }>();
    for (const r of rows) {
      const cur = byWeek.get(r.week_start) ?? { gross: 0, attributed: 0, net: 0 };
      cur.gross += r.revenue_gross_gbp ?? 0;
      cur.attributed += r.revenue_attributed_gbp ?? 0;
      cur.net += r.revenue_net_gbp ?? 0;
      byWeek.set(r.week_start, cur);
    }
    return Array.from(byWeek.entries())
      .map(([week_start, v]) => ({
        week_start,
        revenue_gross_gbp: v.gross,
        revenue_attributed_gbp: v.attributed,
        revenue_net_gbp: v.net,
      }))
      .sort((a, b) => a.week_start.localeCompare(b.week_start))
      .slice(-weeks);
  },
});

// ─────────────────────────────────────────────────────────────────────
// Phase 3 — WallE live signal queries (read-only, no recomputation).
// These power the WallE assistant widget's mood + chat-prompt context.
// ─────────────────────────────────────────────────────────────────────

/** ISO date YYYY-MM-DD `n` days ago in UTC (same convention as isoDaysAgo). */
function isoNDaysAgoUtc(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

/** Today's ISO date YYYY-MM-DD in UTC. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Stable conflict_key (mirrors conflict_dismissals convention). */
function conflictKey(item_id: string, reservation_ids: string[]): string {
  return `${item_id}|${[...reservation_ids].sort().join(",")}`;
}

/** Treat statuses that occupy gear. Mirrors double_booking + calendar logic. */
function isLiveStatus(s: string | undefined | null): boolean {
  if (!s) return false;
  return s === "confirmed" || s === "completed";
}

// ── 6. Active Conflicts (WallE red-alert) ────────────────────────────
// Returns reservations that are double-booked on the same item AND not
// already suppressed via conflict_dismissals.
//
// Algorithm:
//   1. Pull all "live" reservations (confirmed/completed) whose end_date
//      is >= today - 14 (recent past) so we surface in-flight overlaps.
//   2. Bucket by expanded_items[].item_id (falls back to resolved_items).
//   3. For each bucket, sweep pairs with overlapping [start_date, end_date]
//      (date strings sort lex-correctly).
//   4. Build conflict_key for each conflict group; filter out dismissed.
//
// Returns: { id, item, dates, severity }[]
//   severity = "high" if 3+ reservations on same item, else "medium".
export const getActiveConflicts = query({
  args: { _bypassMv: v.optional(v.boolean()) },
  handler: async (ctx, { _bypassMv }) => {
    if (!_bypassMv) {
      const cached = await ctx.db
        .query("mv_walle_signals")
        .withIndex("by_account", (q) => q.eq("account", "all"))
        .first();
      if (cached) return cached.activeConflicts;
    }
    const today = todayIso();
    const lookback = isoNDaysAgoUtc(14);

    // Dismissed conflict_keys → Set
    const dismissed = new Set<string>(
      (await ctx.db.query("conflict_dismissals").collect()).map((d) => d.conflict_key),
    );

    // Pass 8c (2026-05-25): replaced unindexed full-table .collect() with a
    // by_start_date indexed range scan. Any rental with end_date >= 14d_ago
    // has start_date >= ~60d_ago (rentals typically last <30 days). The
    // 60d cutoff is a safe over-fetch that drops the scan from ~1700 rows
    // to ~250. Subscribed by WallESignals so it re-evals on every
    // reservation mutation — this is the highest-impact WallE fix.
    const conflictsCutoff = isoNDaysAgoUtc(60);
    const recentRes = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", conflictsCutoff))
      .collect();
    const live = recentRes.filter(
      (r) =>
        isLiveStatus(r.status) &&
        r.start_date !== undefined &&
        r.end_date !== undefined &&
        r.end_date >= lookback,
    );

    // Bucket by item_id using expanded_items (authoritative for conflicts).
    type Bucket = { item_id: string; item_name: string; rows: typeof live };
    const buckets = new Map<string, Bucket>();
    for (const r of live) {
      const exp = r.expanded_items ?? [];
      const fallback = exp.length === 0 ? (r.resolved_items ?? []) : exp;
      for (const ei of fallback) {
        const key = ei.item_id as unknown as string;
        const cur = buckets.get(key);
        if (cur) cur.rows.push(r);
        else
          buckets.set(key, {
            item_id: key,
            item_name: ei.item_name_canonical,
            rows: [r],
          });
      }
    }

    // Sweep for overlapping pairs per bucket.
    type Conflict = {
      id: string;
      item: string;
      dates: string;
      severity: "high" | "medium";
    };
    const out: Conflict[] = [];
    for (const b of buckets.values()) {
      if (b.rows.length < 2) continue;
      // Find overlapping groups: simple O(n^2) — n is tiny per item.
      const groups: typeof b.rows[] = [];
      for (let i = 0; i < b.rows.length; i++) {
        for (let j = i + 1; j < b.rows.length; j++) {
          const a = b.rows[i];
          const c = b.rows[j];
          // Inclusive overlap on date strings (YYYY-MM-DD sortable).
          if (a.start_date! <= c.end_date! && c.start_date! <= a.end_date!) {
            groups.push([a, c]);
          }
        }
      }
      if (groups.length === 0) continue;

      // Merge to a single group of unique reservations for this item
      // (so 3-way conflicts produce one dismissable key).
      const seen = new Map<string, typeof b.rows[number]>();
      for (const grp of groups) {
        for (const r of grp) {
          const key = r._id as unknown as string;
          if (!seen.has(key)) seen.set(key, r);
        }
      }
      const conflictRows = Array.from(seen.values());
      const reservation_ids = conflictRows.map((r) => r._id as unknown as string);
      const key = conflictKey(b.item_id, reservation_ids);
      if (dismissed.has(key)) continue;

      // Date span: earliest start → latest end.
      const minStart = conflictRows.reduce(
        (acc, r) => (r.start_date! < acc ? r.start_date! : acc),
        conflictRows[0].start_date!,
      );
      const maxEnd = conflictRows.reduce(
        (acc, r) => (r.end_date! > acc ? r.end_date! : acc),
        conflictRows[0].end_date!,
      );
      out.push({
        id: key,
        item: b.item_name,
        dates: `${minStart} → ${maxEnd}`,
        severity: conflictRows.length >= 3 ? "high" : "medium",
      });
    }
    return out;
  },
});

// ── 7. Utilization Delta (WallE week-over-week movers) ───────────────
// For each item with reservations in the trailing 14 days, count
// booked-days this-week (last 7d) vs last-week (prior 7d). Return items
// with absolute delta >= 20%, sorted by abs(deltaPct) desc, top 10.
export const getUtilizationDelta = query({
  args: { _bypassMv: v.optional(v.boolean()) },
  handler: async (ctx, { _bypassMv }) => {
    if (!_bypassMv) {
      const cached = await ctx.db
        .query("mv_walle_signals")
        .withIndex("by_account", (q) => q.eq("account", "all"))
        .first();
      if (cached) return cached.utilizationDelta;
    }
    const today = todayIso();
    const start14 = isoNDaysAgoUtc(14);
    const start7 = isoNDaysAgoUtc(7);

    // Pass 8c (2026-05-25): by_start_date indexed scan w/ 60d cutoff to
    // bound the read (any rental whose end_date intersects last 14d had
    // start_date within ~45d ago). Same WallE re-eval fix as
    // getActiveConflicts.
    const utilCutoff = isoNDaysAgoUtc(60);
    const recentRes = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", utilCutoff))
      .collect();
    const recent = recentRes.filter(
      (r) =>
        isLiveStatus(r.status) &&
        r.start_date !== undefined &&
        r.end_date !== undefined &&
        r.end_date >= start14 &&
        r.start_date <= today,
    );

    // For each item, accumulate days-this-week vs days-prev-week.
    type Acc = { item_id: string; name: string; cur: number; prev: number };
    const agg = new Map<string, Acc>();

    const dayMs = 86400000;
    const tToday = Date.parse(today + "T00:00:00Z");
    const t7 = Date.parse(start7 + "T00:00:00Z");
    const t14 = Date.parse(start14 + "T00:00:00Z");

    function overlapDays(startIso: string, endIso: string, winStart: number, winEnd: number): number {
      const s = Date.parse(startIso + "T00:00:00Z");
      const e = Date.parse(endIso + "T00:00:00Z");
      const lo = Math.max(s, winStart);
      const hi = Math.min(e, winEnd);
      if (hi < lo) return 0;
      // Inclusive day count (Hygglo convention).
      return Math.max(1, Math.round((hi - lo) / dayMs) + 1);
    }

    for (const r of recent) {
      const items = r.expanded_items ?? r.resolved_items ?? [];
      for (const ei of items) {
        const key = ei.item_id as unknown as string;
        const qty = (ei as { qty?: number }).qty ?? 1;
        const dCur = overlapDays(r.start_date!, r.end_date!, t7, tToday) * qty;
        const dPrev = overlapDays(r.start_date!, r.end_date!, t14, t7 - dayMs) * qty;
        const cur = agg.get(key);
        if (cur) {
          cur.cur += dCur;
          cur.prev += dPrev;
        } else {
          agg.set(key, {
            item_id: key,
            name: ei.item_name_canonical,
            cur: dCur,
            prev: dPrev,
          });
        }
      }
    }

    const rows = Array.from(agg.values()).map((a) => {
      const base = a.prev === 0 ? Math.max(a.cur, 1) : a.prev;
      const deltaPct = ((a.cur - a.prev) / base) * 100;
      return {
        itemId: a.item_id,
        name: a.name,
        currentDays: a.cur,
        prevDays: a.prev,
        deltaPct: Math.round(deltaPct * 10) / 10,
      };
    });

    return rows
      .filter((r) => Math.abs(r.deltaPct) >= 20)
      .sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct))
      .slice(0, 10);
  },
});

// ── 8. Revenue Delta (WallE green-celebrate trigger) ─────────────────
// Computes MTD revenue and compares against the same day-range of the
// previous month. Uses reservations.gross_paid_gbp (canonical revenue
// figure across v2) summed over reservations whose start_date falls in
// the window. historical_revenue is monthly-rollup-only — too coarse
// for "same day range so far" — so we compute from reservations directly.
//
// Returns: { mtdGbp, vsLastMonthPct, vsForecastPct }
//   vsForecastPct = null (no forecast table in v2 yet).
export const getRevenueDelta = query({
  args: { _bypassMv: v.optional(v.boolean()) },
  handler: async (ctx, { _bypassMv }) => {
    if (!_bypassMv) {
      const cached = await ctx.db
        .query("mv_walle_signals")
        .withIndex("by_account", (q) => q.eq("account", "all"))
        .first();
      if (cached) return cached.revenueDelta;
    }
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth(); // 0-based
    const dayOfMonth = now.getUTCDate();

    const pad = (n: number) => n.toString().padStart(2, "0");
    const monthStart = (yr: number, mo: number) => `${yr}-${pad(mo + 1)}-01`;

    // Current MTD window: [first-of-month, today]
    const curStart = monthStart(y, m);
    const curEnd = `${y}-${pad(m + 1)}-${pad(dayOfMonth)}`;

    // Last month same day-range: [first-of-last-month, first-of-last-month + (dayOfMonth-1)]
    const prevY = m === 0 ? y - 1 : y;
    const prevM = m === 0 ? 11 : m - 1;
    const prevStart = monthStart(prevY, prevM);
    // Clamp day to last day of previous month (handle 31 → 30/28).
    const daysInPrev = new Date(Date.UTC(prevY, prevM + 1, 0)).getUTCDate();
    const prevDay = Math.min(dayOfMonth, daysInPrev);
    const prevEnd = `${prevY}-${pad(prevM + 1)}-${pad(prevDay)}`;

    // Pass 8c (2026-05-25): by_start_date indexed scan bounded to start of
    // last month (the earliest date the prev-month window can reach).
    // Drops the scan from full table to ~150-300 rows for the MTD vs
    // prev-month comparison the WallE widget renders.
    const all = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", prevStart))
      .collect();
    let mtdGbp = 0;
    let prevGbp = 0;
    for (const r of all) {
      if (!isLiveStatus(r.status)) continue;
      // REVENUE-SUM CANON (order_step_semantics.ts): require renter has
      // funded escrow before counting toward MTD revenue. Today
      // isLiveStatus (confirmed|completed) already excludes APPROVED /
      // FUNDS_RESERVED because those carry status="pending_review", but
      // we add the explicit isPaid guard so a poller change that
      // re-routes the status field can't silently leak unpaid rows into
      // the MTD total. v1-imported rows have no order_step but
      // trustworthy status="completed" — accept via the v1-legacy escape
      // hatch (mirrors isPaidWithV1Legacy in predicates.ts).
      if (r.order_step ? !isPaid(r.order_step) : r.status !== "confirmed" && r.status !== "completed") continue;
      const sd = r.start_date;
      if (!sd) continue;
      const rev = r.gross_paid_gbp ?? 0;
      if (sd >= curStart && sd <= curEnd) mtdGbp += rev;
      else if (sd >= prevStart && sd <= prevEnd) prevGbp += rev;
    }

    const vsLastMonthPct =
      prevGbp === 0 ? (mtdGbp > 0 ? 100 : 0) : ((mtdGbp - prevGbp) / prevGbp) * 100;

    return {
      mtdGbp: Math.round(mtdGbp * 100) / 100,
      vsLastMonthPct: Math.round(vsLastMonthPct * 10) / 10,
      vsForecastPct: null as number | null,
    };
  },
});
