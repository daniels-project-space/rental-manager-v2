/**
 * Phase 7.11 — diagnostic for why so few owner_denied reservations are
 * classified as `capacity_gap`. Surfaces each owner_denied reservation's
 * inputs to diagnoseDenialCapacity:
 *   - refs (item_id list from expanded/resolved_items)
 *   - per-item per-date commitments vs items.qty
 *   - items.is_marketing_only flag
 *   - reasons it falls to "voluntary" or "unknown" or "below_minimum_threshold"
 *
 * Output is intentionally compact so it can be eyeballed at scale.
 */

import { v } from "convex/values";
import { query } from "./_generated/server";
import {
  buildCommitmentMap,
  diagnoseDenialCapacity,
  isCompletedCommitting,
} from "./lib/capacity_gap";

export const diagnoseAllOwnerDenied = query({
  args: { days: v.number(), limit: v.number() },
  handler: async (ctx, { days, limit }) => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffMs = cutoff.getTime();
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const pricingRows = await ctx.db.query("pricing_catalog").collect();
    const priceByName = new Map(
      pricingRows.map((p) => [p.item_name_canonical, p.daily_price_min]),
    );

    let obsoleteRes = await ctx.db
      .query("reservations")
      .filter((q) => q.eq(q.field("is_obsolete"), true))
      .collect();
    obsoleteRes = obsoleteRes.filter((r) => {
      const ts = r.obsolete_at ?? r.v1_updated_at ?? r._creationTime;
      return ts >= cutoffMs;
    });
    const ownerDenied = obsoleteRes.filter((r) => {
      const actor = r.reclassified_outcome ?? r.denial_actor;
      return actor === "owner_denied";
    });

    const completedAll = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoffStr))
      .collect();
    const commitMap = buildCommitmentMap(
      completedAll.filter(isCompletedCommitting),
    );

    // Count statuses of all reservations in window for hypothesis check
    const statusCounts: Record<string, number> = {};
    for (const r of completedAll) {
      const s = `${r.status ?? "null"}|obs=${r.is_obsolete ? 1 : 0}`;
      statusCounts[s] = (statusCounts[s] ?? 0) + 1;
    }

    const rows: any[] = [];
    let causeCounts: Record<string, number> = {};
    let noItemsCount = 0;
    let noDatesCount = 0;
    let qtyZeroCount = 0;
    let mktOnlyCount = 0;
    let nearMissCount = 0;
    let voluntaryButCommitted = 0;

    for (const r of ownerDenied.slice(0, limit)) {
      const diag = await diagnoseDenialCapacity(ctx, r, commitMap, priceByName);
      causeCounts[diag.cause] = (causeCounts[diag.cause] ?? 0) + 1;

      if (diag.per_item_diagnosis.length === 0) noItemsCount += 1;

      const refs = (r.expanded_items ?? r.resolved_items ?? []).filter(
        (x: any) => x.item_id,
      );

      // per-item summary
      const per = diag.per_item_diagnosis.map((p) => ({
        name: p.canonical_name,
        committed: p.units_committed,
        total: p.units_total,
        mkt: p.is_marketing_only,
        class: p.classification,
      }));
      for (const p of per) {
        if (p.total === 0) qtyZeroCount += 1;
        if (p.mkt) mktOnlyCount += 1;
        if (
          p.class === "voluntary" &&
          p.committed > 0 &&
          p.committed < p.total
        ) {
          nearMissCount += 1;
        }
        if (p.class === "voluntary" && p.committed > 0) {
          voluntaryButCommitted += 1;
        }
      }

      rows.push({
        id: r._id,
        actor: r.reclassified_outcome ?? r.denial_actor,
        start: r.start_date,
        end: r.end_date,
        duration: r.duration_days,
        gross: r.gross_paid_gbp,
        loss: diag.estimated_loss_gbp,
        cause: diag.cause,
        refs_count: refs.length,
        items_raw: (r.items ?? []).map((i: any) => i.item_name).slice(0, 3),
        per,
      });
    }

    return {
      total_owner_denied: ownerDenied.length,
      sampled: rows.length,
      cause_counts: causeCounts,
      no_items_count: noItemsCount,
      no_dates_count: noDatesCount,
      qty_zero_count: qtyZeroCount,
      mkt_only_count: mktOnlyCount,
      near_miss_count: nearMissCount,
      voluntary_with_some_commitment: voluntaryButCommitted,
      commit_map_size: commitMap.size,
      completed_status_counts: statusCounts,
      rows,
    };
  },
});

/**
 * Diagnostic — surface every reservation status that ever appears + obsolete
 * flag combinations, to see if e.g. `pending` rentals should count.
 */
export const reservationStatusDistribution = query({
  args: { days: v.number() },
  handler: async (ctx, { days }) => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const all = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoffStr))
      .collect();

    const counts: Record<string, number> = {};
    for (const r of all) {
      const k = `${r.status ?? "null"}|obs=${r.is_obsolete ? 1 : 0}|actor=${
        r.reclassified_outcome ?? r.denial_actor ?? "none"
      }`;
      counts[k] = (counts[k] ?? 0) + 1;
    }
    return counts;
  },
});

/**
 * Distinct items.is_marketing_only summary — confirm flag is populated.
 */
export const itemsMarketingFlagSummary = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("items").collect();
    let mkt = 0;
    let nonMkt = 0;
    let nullMkt = 0;
    let qtyZero = 0;
    let qtyNull = 0;
    const examples: any[] = [];
    for (const it of all) {
      if (it.is_marketing_only === true) {
        mkt += 1;
        if (examples.length < 5)
          examples.push({ name: it.name_canonical, qty: it.qty });
      } else if (it.is_marketing_only === false) nonMkt += 1;
      else nullMkt += 1;
      if (it.qty === 0) qtyZero += 1;
      if (it.qty == null) qtyNull += 1;
    }
    return {
      total: all.length,
      marketing_only: mkt,
      not_marketing_only: nonMkt,
      mkt_null: nullMkt,
      qty_zero: qtyZero,
      qty_null: qtyNull,
      mkt_examples: examples,
    };
  },
});
