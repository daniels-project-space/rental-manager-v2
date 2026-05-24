/**
 * MV: mv_item_roi_rankings (phase 6c, 2026-05-24)
 *
 * Pre-computes the global per-item ROI ranking from 2y of reservations +
 * items. Replaces a 2-year reservations.collect() + items.collect() on
 * every dashboard ItemROIPanel re-evaluation with a single indexed row
 * read; ItemROIPanel + chat tool + Trigger.dev snapshot writer all slice
 * the stored rows[] tail.
 *
 * Refreshed by master.refreshSlow (daily). ROI is dominated by lifetime
 * net + acquisition cost — both slow-moving (~daily changes at most),
 * so daily refresh is plenty.
 */
import { v } from "convex/values";
import { internalMutation, query } from "../_generated/server";
import { ACCOUNT_ALL } from "./constants";
import { isPaidWithV1Legacy } from "../lib/reservations/predicates";

/** ROI is global, not per-account. Singleton key. */
const ROI_KEY = ACCOUNT_ALL;

/** 2-year lifetime window for the ranking. Forward-safe today; revisit
 *  when Daniel's dataset history grows past 2y. */
export const ROI_WINDOW_DAYS = 730;

type ItemRow = {
  _id: string;
  name_canonical: string;
  kind?: string;
  qty?: number;
  status: string;
  is_marketing_only?: boolean;
  acquisition_cost_gbp?: number | null;
  acquired_at?: number;
  created_at: number;
};

type ReservationRow = {
  status?: string;
  is_obsolete?: boolean;
  order_step?: string;
  gross_paid_gbp?: number;
  net_to_owner_gbp?: number;
  expanded_items?: Array<{ item_id: string; qty: number }>;
  resolved_items?: Array<{ item_id: string; qty?: number }>;
};

export type RoiRow = {
  itemId: string;
  name: string;
  kind?: string;
  qty?: number;
  acquisitionCostGbp: number | null;
  lifetimeGrossGbp: number;
  lifetimeNetGbp: number;
  rentalCount: number;
  monthsOwned: number;
  monthlyAvgNetGbp: number;
  roiPct: number | null;
  annualizedROIPct: number | null;
};

/** Mirror of intel.ts:grossShare. Inlined here so the MV stays
 *  self-contained — keep in sync if the live helper changes. */
function grossShare(r: ReservationRow, itemId: string): { gross: number; net: number } {
  const expanded = r.expanded_items ?? [];
  if (expanded.length > 0) {
    const totalQty = expanded.reduce((s, x) => s + (x.qty ?? 1), 0);
    const mine = expanded
      .filter((x) => x.item_id === itemId)
      .reduce((s, x) => s + (x.qty ?? 1), 0);
    if (totalQty > 0 && mine > 0) {
      return {
        gross: (r.gross_paid_gbp ?? 0) * (mine / totalQty),
        net: (r.net_to_owner_gbp ?? 0) * (mine / totalQty),
      };
    }
  }
  const resolved = r.resolved_items ?? [];
  if (resolved.length > 0) {
    const totalQty = resolved.reduce((s, x) => s + (x.qty ?? 1), 0);
    const mine = resolved
      .filter((x) => x.item_id === itemId)
      .reduce((s, x) => s + (x.qty ?? 1), 0);
    if (totalQty > 0 && mine > 0) {
      return {
        gross: (r.gross_paid_gbp ?? 0) * (mine / totalQty),
        net: (r.net_to_owner_gbp ?? 0) * (mine / totalQty),
      };
    }
  }
  return { gross: 0, net: 0 };
}

/** Pure compute — items is the full items table, reservations is the
 *  2-year window. Returns the rows[] payload sorted by annualized ROI desc.
 */
export function computeItemRoiRanking(args: {
  items: ItemRow[];
  reservations: ReservationRow[];
  generatedAt?: number;
}): RoiRow[] {
  const { items, reservations } = args;
  const generatedAt = args.generatedAt ?? Date.now();
  const active = items.filter((i) => i.status === "active" && !i.is_marketing_only);

  const grossByItem = new Map<string, { gross: number; net: number; rentalCount: number }>();
  for (const r of reservations) {
    if (!isPaidWithV1Legacy(r as unknown as Parameters<typeof isPaidWithV1Legacy>[0])) continue;
    const seenInRow = new Set<string>();
    const expanded = r.expanded_items ?? r.resolved_items ?? [];
    for (const x of expanded) {
      if (seenInRow.has(x.item_id)) continue;
      seenInRow.add(x.item_id);
      const share = grossShare(r, x.item_id);
      const cur = grossByItem.get(x.item_id) ?? { gross: 0, net: 0, rentalCount: 0 };
      cur.gross += share.gross;
      cur.net += share.net;
      cur.rentalCount += 1;
      grossByItem.set(x.item_id, cur);
    }
  }

  const rows: RoiRow[] = active.map((i) => {
    const stats = grossByItem.get(i._id) ?? { gross: 0, net: 0, rentalCount: 0 };
    const acquired = i.acquired_at ?? i.created_at;
    const monthsOwned = Math.max(
      1,
      (generatedAt - acquired) / (1000 * 60 * 60 * 24 * 30),
    );
    const cost = i.acquisition_cost_gbp ?? null;
    const lifetimeNet = Math.round(stats.net * 100) / 100;
    const lifetimeGross = Math.round(stats.gross * 100) / 100;
    const monthlyNet = stats.net / monthsOwned;
    const roiPct = cost && cost > 0 ? (stats.net / cost) * 100 : null;
    const annualizedROIPct = cost && cost > 0 ? (monthlyNet * 12 / cost) * 100 : null;
    return {
      itemId: i._id,
      name: i.name_canonical,
      kind: i.kind,
      qty: i.qty,
      acquisitionCostGbp: cost,
      lifetimeGrossGbp: lifetimeGross,
      lifetimeNetGbp: lifetimeNet,
      rentalCount: stats.rentalCount,
      monthsOwned: Math.round(monthsOwned * 10) / 10,
      monthlyAvgNetGbp: Math.round(monthlyNet * 100) / 100,
      roiPct: roiPct === null ? null : Math.round(roiPct * 10) / 10,
      annualizedROIPct:
        annualizedROIPct === null ? null : Math.round(annualizedROIPct * 10) / 10,
    };
  });

  rows.sort((a, b) => (b.annualizedROIPct ?? -Infinity) - (a.annualizedROIPct ?? -Infinity));
  return rows;
}

/** Standalone refresh — direct invocation. Hot path goes through
 *  master.refreshSlow. */
export const refresh = internalMutation({
  args: {},
  handler: async (ctx) => {
    const startedAt = Date.now();
    const cutoff = new Date(startedAt - ROI_WINDOW_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const [items, reservations] = await Promise.all([
      ctx.db.query("items").collect(),
      ctx.db.query("reservations")
        .withIndex("by_start_date", (q) => q.gte("start_date", cutoff))
        .collect(),
    ]);
    const rows = computeItemRoiRanking({
      items: items as unknown as ItemRow[],
      reservations: reservations as unknown as ReservationRow[],
      generatedAt: startedAt,
    });
    const existing = await ctx.db
      .query("mv_item_roi_rankings")
      .withIndex("by_account", (q) => q.eq("account", ROI_KEY))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { generatedAt: startedAt, rows });
    } else {
      await ctx.db.insert("mv_item_roi_rankings", {
        account: ROI_KEY,
        generatedAt: startedAt,
        rows,
      });
    }
    return { ok: true, count: rows.length, durationMs: Date.now() - startedAt };
  },
});

/** Reader — applies caller-side filters (limit, include_unknown_cost). */
export const get = query({
  args: {
    limit: v.optional(v.number()),
    include_unknown_cost: v.optional(v.boolean()),
  },
  handler: async (ctx, { limit, include_unknown_cost }) => {
    const row = await ctx.db
      .query("mv_item_roi_rankings")
      .withIndex("by_account", (q) => q.eq("account", ROI_KEY))
      .first();
    if (!row) return null;
    const all = row.rows;
    const filtered = include_unknown_cost
      ? all
      : all.filter((r) => r.acquisitionCostGbp !== null);
    return {
      ok: true as const,
      count: filtered.length,
      rows: filtered.slice(0, limit ?? 20),
      generatedAt: row.generatedAt,
      note:
        all.length > filtered.length && !include_unknown_cost
          ? `${all.length - filtered.length} items have no acquisition cost recorded — pass include_unknown_cost:true to include them.`
          : undefined,
    };
  },
});
