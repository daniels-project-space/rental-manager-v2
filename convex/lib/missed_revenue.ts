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

  const rentalDaysPerItem = new Map<string, number>();
  for (const r of allResForGap) {
    for (const item of r.items ?? []) {
      rentalDaysPerItem.set(
        item.item_name,
        (rentalDaysPerItem.get(item.item_name) ?? 0) + (r.duration_days ?? 0),
      );
    }
  }

  const pricingRows = await ctx.db.query("pricing_catalog").collect();
  const priceByName = new Map(
    pricingRows.map((p) => [p.item_name_canonical, p.daily_price_min]),
  );

  const gapLosses: GapLoss[] = [];
  for (const [itemName, rentalDays] of rentalDaysPerItem.entries()) {
    const idleDays = Math.max(0, days - Math.min(rentalDays, days));
    if (idleDays <= 0) continue;
    const dailyRate = priceByName.get(itemName);
    if (!dailyRate) continue;
    gapLosses.push({
      itemName,
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

  // Headline total now combines denials + gap (per panel convention).
  const totalMissed = parseFloat((denialTotal + gapTotal).toFixed(2));

  return {
    totalMissed,
    denialTotal,
    gapTotal,
    denialLosses,
    gapLosses,
  };
}
