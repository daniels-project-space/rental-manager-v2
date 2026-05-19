// Phase 7 — Dashboard insight widgets that consume weekly_metrics rollup.
// Five small read queries — no recomputation, just aggregations over Phase 5's table.

import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

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
