/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Missed Revenue — shared helper (single source of truth).
 * ──────────────────────────────────────────────────────────────────────────
 *
 *  Used by:
 *   - convex/revenue.ts          → getMissedRevenue (panel/W14)
 *   - convex/dashboard.ts        → getStatsDrawerData.missed_revenue (top tile)
 *
 *  Headline behaviour: total = denialLosses + gapLosses (both NET, post
 *  platform-fee). The standalone panel and the top tile must always agree.
 *
 *  Net convention (2026-05-22, commit 4a77ed3):
 *    denial_records.estimated_value AND pricing_catalog.daily_price_min are
 *    GROSS Hygglo £. Project rule = revenue is take-home post platform fees
 *    (~36%). Multiply by OWNER_SHARE = 0.64 so this matches every other
 *    revenue widget (netOf(r) → net_to_owner_gbp).
 */
import type { QueryCtx } from "../_generated/server";
import { OWNER_SHARE } from "./revenue_attribution";

// Re-export so existing import sites stay valid after consolidation (Wave 1.4).
export { OWNER_SHARE };

export type DenialLoss = {
  denialId: string;
  reason: string | undefined;
  itemName: string | undefined;
  estimatedValue: number;       // net (post-platform-fee), headline
  estimatedValueGross: number;
  notes: string | undefined;
  createdAt: number;
};

export type GapLoss = {
  itemName: string;
  rentalDays: number;
  idleDays: number;
  estimatedGapLoss: number;     // net
};

export type MissedRevenueResult = {
  totalMissed: number;          // denialTotal + gapTotal (NET) — headline
  denialTotal: number;
  gapTotal: number;
  denialLosses: DenialLoss[];
  gapLosses: GapLoss[];
};

/**
 * Compute denial + idle-gap losses for an account over the trailing N days.
 * Both totals are NET (post-platform-fee). Headline `totalMissed` combines
 * the two so dashboard top tile + standalone panel show the same number.
 */
export async function computeMissedRevenue(
  ctx: QueryCtx,
  accountSlug: string | null,
  days: number,
): Promise<MissedRevenueResult> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  // ── Denial losses ────────────────────────────────────────────
  let denials = await ctx.db.query("denial_records").collect();
  if (accountSlug) {
    const accountRow = await ctx.db
      .query("accounts")
      .withIndex("by_slug", (q) => q.eq("slug", accountSlug as string))
      .first();
    if (accountRow) {
      denials = denials.filter((d) => d.account_id === accountRow._id);
    }
  }
  denials = denials.filter((d) => d.created_at >= cutoff.getTime());

  const denialLosses: DenialLoss[] = await Promise.all(
    denials.map(async (d) => {
      let estimatedValueGross = d.estimated_value ?? 0;
      if (estimatedValueGross === 0 && d.item_name) {
        const priceRow = await ctx.db
          .query("pricing_catalog")
          .withIndex("by_name", (q) =>
            q.eq("item_name_canonical", d.item_name as string),
          )
          .first();
        if (priceRow) {
          // Assume a 2-day average rental
          estimatedValueGross = priceRow.daily_price_min * 2;
        }
      }
      const estimatedValue = parseFloat(
        (estimatedValueGross * OWNER_SHARE).toFixed(2),
      );
      return {
        denialId: d._id as string,
        reason: d.reason,
        itemName: d.item_name,
        estimatedValue,
        estimatedValueGross,
        notes: d.notes,
        createdAt: d.created_at,
      };
    }),
  );

  const denialTotal = parseFloat(
    denialLosses.reduce((sum, d) => sum + d.estimatedValue, 0).toFixed(2),
  );

  // ── Idle-gap losses ──────────────────────────────────────────
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  let allResForGap = await ctx.db
    .query("reservations")
    .withIndex("by_start_date", (q) => q.gte("start_date", cutoffStr))
    .collect();
  if (accountSlug) {
    allResForGap = allResForGap.filter((r) => r.account_slug === accountSlug);
  }

  // Attribute by CANONICAL item name (the resolver's expanded_items) so it
  // matches pricing_catalog.item_name_canonical — the old raw item_name lookup
  // always missed and gapTotal collapsed to £0. Fall back to raw names for rows
  // the resolver hasn't processed yet.
  const rentalDaysPerItem = new Map<string, number>();
  for (const r of allResForGap) {
    const canon =
      r.expanded_items && r.expanded_items.length
        ? r.expanded_items
        : r.resolved_items && r.resolved_items.length
          ? r.resolved_items
          : null;
    const names = canon
      ? canon
          .map((x) => x.item_name_canonical)
          .filter((n): n is string => !!n)
      : (r.items ?? []).map((it) => it.item_name);
    for (const name of names) {
      rentalDaysPerItem.set(
        name,
        (rentalDaysPerItem.get(name) ?? 0) + (r.duration_days ?? 0),
      );
    }
  }

  const pricingRows = await ctx.db.query("pricing_catalog").collect();
  const priceByName = new Map(
    pricingRows.map((p) => [p.item_name_canonical, p.daily_price_min]),
  );

  // Idle gap for gear that ACTUALLY rented in the window (demand-proven
  // underutilisation). We deliberately do NOT sweep the whole pricing_catalog:
  // it carries ~470 rows (bundles, kits, duplicate variants), so a
  // full-inventory theoretical-max balloons to ~£290k of meaningless "idle" —
  // gear with zero demand isn't missed revenue. Restricting to rented items
  // keeps this an honest "in-demand kit that still sat idle" figure.
  const gapLosses: GapLoss[] = [];
  for (const [name, rentalDays] of rentalDaysPerItem.entries()) {
    const idleDays = Math.max(0, days - Math.min(rentalDays, days));
    if (idleDays <= 0) continue;
    const dailyRate = priceByName.get(name);
    if (!dailyRate) continue;
    gapLosses.push({
      itemName: name,
      rentalDays,
      idleDays,
      estimatedGapLoss: parseFloat(
        (idleDays * dailyRate * OWNER_SHARE).toFixed(2),
      ),
    });
  }
  gapLosses.sort((a, b) => b.estimatedGapLoss - a.estimatedGapLoss);

  const gapTotal = parseFloat(
    gapLosses.reduce((s, g) => s + g.estimatedGapLoss, 0).toFixed(2),
  );

  // Missed = idle-capacity opportunity ONLY (disjoint from denied_revenue,
  // which counts declined requests). denialTotal/denialLosses are still
  // returned for the breakdown panel.
  const totalMissed = gapTotal;

  return {
    totalMissed,
    denialTotal,
    gapTotal,
    denialLosses,
    gapLosses,
  };
}
