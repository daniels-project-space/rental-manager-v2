// convex/audit_data_quality.ts — READ-ONLY audit queries (Phase 1 inspection)
// Source: /tmp/audit_data_quality.md §7. No DB writes.
//
// Run:
//   npx convex run --prod audit_data_quality:auditItemCoverage
//   npx convex run --prod audit_data_quality:auditPricingCoverage
//   npx convex run --prod audit_data_quality:auditExpandedItemsPresence
//   npx convex run --prod audit_data_quality:auditOtherBucketSubclasses

import { query } from "./_generated/server";
import { v } from "convex/values";

/**
 * For each `kind`, count items + how many have replacement_cost /
 * included_with_rental / appear in some bundle.
 */
export const auditItemCoverage = query({
  args: {},
  handler: async (ctx) => {
    const items = await ctx.db.query("items").collect();
    const bundleItems = await ctx.db.query("bundle_items").collect();
    const inBundle = new Set<string>();
    for (const bi of bundleItems) if (bi.item_id) inBundle.add(bi.item_id as string);

    const byKind = new Map<
      string,
      { count: number; with_rc: number; with_inc: number; in_some_bundle: number; names: string[] }
    >();
    for (const it of items) {
      const k = it.kind ?? "unknown";
      const slot = byKind.get(k) ?? { count: 0, with_rc: 0, with_inc: 0, in_some_bundle: 0, names: [] };
      slot.count++;
      if (typeof it.replacement_cost_gbp === "number" && it.replacement_cost_gbp > 0) slot.with_rc++;
      const inc = it.compatibility?.included_with_rental;
      if (Array.isArray(inc) && inc.length > 0) slot.with_inc++;
      if (inBundle.has(it._id as string)) slot.in_some_bundle++;
      slot.names.push(it.name_canonical);
      byKind.set(k, slot);
    }
    const rows = [...byKind.entries()]
      .map(([kind, val]) => ({ kind, ...val }))
      .sort((a, b) => b.count - a.count);
    const totals = rows.reduce(
      (s, r) => ({
        count: s.count + r.count,
        with_rc: s.with_rc + r.with_rc,
        with_inc: s.with_inc + r.with_inc,
        in_some_bundle: s.in_some_bundle + r.in_some_bundle,
      }),
      { count: 0, with_rc: 0, with_inc: 0, in_some_bundle: 0 },
    );
    return { rows, totals };
  },
});

/**
 * MASTER_INVENTORY items missing from pricing_catalog AND appearing on ≥1
 * rental in last `days` (default 90). Uses items.name_canonical as join key.
 */
export const auditPricingCoverage = query({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, { days }) => {
    const items = await ctx.db.query("items").collect();
    const pricing = await ctx.db.query("pricing_catalog").collect();
    const pricedNames = new Set(pricing.map((p) => p.item_name_canonical));

    const cutoff = Date.now() - (days ?? 90) * 86_400_000;
    const cutoffStr = new Date(cutoff).toISOString().slice(0, 10);

    const recent = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoffStr))
      .collect();

    const appearances = new Map<string, number>();
    for (const r of recent) {
      const resolved = (r as { resolved_items?: Array<{ item_name_canonical: string }> })
        .resolved_items ?? [];
      for (const x of resolved) {
        appearances.set(x.item_name_canonical, (appearances.get(x.item_name_canonical) ?? 0) + 1);
      }
    }

    const missingPriced = items
      .filter((it) => !pricedNames.has(it.name_canonical))
      .map((it) => ({
        name_canonical: it.name_canonical,
        kind: it.kind,
        rental_appearances_90d: appearances.get(it.name_canonical) ?? 0,
      }))
      .filter((r) => r.rental_appearances_90d >= 1)
      .sort((a, b) => b.rental_appearances_90d - a.rental_appearances_90d);

    return {
      cutoff: cutoffStr,
      total_items: items.length,
      priced_items: items.filter((it) => pricedNames.has(it.name_canonical)).length,
      missing_priced_with_recent_rentals: missingPriced,
    };
  },
});

/**
 * For reservations in last `days` (default 90), count which item-list fields
 * are populated. Phase 2 relies on resolved_items / expanded_items — this
 * tells us how many it would skip.
 */
export const auditExpandedItemsPresence = query({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, { days }) => {
    const cutoff = Date.now() - (days ?? 90) * 86_400_000;
    const cutoffStr = new Date(cutoff).toISOString().slice(0, 10);
    const rows = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoffStr))
      .collect();

    let has_expanded = 0,
      has_resolved_only = 0,
      has_raw_only = 0,
      has_nothing = 0,
      total_with_gross = 0;
    let revenue_has_expanded = 0,
      revenue_has_resolved_only = 0,
      revenue_has_raw_only = 0,
      revenue_has_nothing = 0;

    for (const r of rows) {
      const exp = (r as { expanded_items?: unknown[] }).expanded_items;
      const res = (r as { resolved_items?: unknown[] }).resolved_items;
      const raw = r.items;
      const gross = r.gross_paid_gbp ?? 0;
      if (gross > 0) total_with_gross++;

      if (Array.isArray(exp) && exp.length > 0) {
        has_expanded++;
        revenue_has_expanded += gross;
      } else if (Array.isArray(res) && res.length > 0) {
        has_resolved_only++;
        revenue_has_resolved_only += gross;
      } else if (Array.isArray(raw) && raw.length > 0) {
        has_raw_only++;
        revenue_has_raw_only += gross;
      } else {
        has_nothing++;
        revenue_has_nothing += gross;
      }
    }

    return {
      cutoff: cutoffStr,
      total: rows.length,
      total_with_gross,
      counts: { has_expanded, has_resolved_only, has_raw_only, has_nothing },
      revenue: {
        has_expanded: Math.round(revenue_has_expanded * 100) / 100,
        has_resolved_only: Math.round(revenue_has_resolved_only * 100) / 100,
        has_raw_only: Math.round(revenue_has_raw_only * 100) / 100,
        has_nothing: Math.round(revenue_has_nothing * 100) / 100,
      },
    };
  },
});

/**
 * SMOKING GUN: what's actually inside the "Other" bucket?
 * For last-`days` reservations, attribute each resolved_item to its kind via
 * legacy pricing-weighted split (mirrors dashboard.ts:1511-1516), then surface
 * the kinds that fall OUTSIDE the top-6 (folded into "Other" by the chart).
 */
export const auditOtherBucketSubclasses = query({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, { days }) => {
    const cutoff = Date.now() - (days ?? 90) * 86_400_000;
    const cutoffStr = new Date(cutoff).toISOString().slice(0, 10);
    const rows = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoffStr))
      .collect();
    const items = await ctx.db.query("items").collect();
    const kindById = new Map<string, string>();
    for (const it of items) {
      kindById.set(it._id as string, it.kind);
    }
    const pricing = await ctx.db.query("pricing_catalog").collect();
    const priceByName = new Map<string, number>();
    for (const p of pricing) priceByName.set(p.item_name_canonical, p.daily_price_min);

    const countByKind = new Map<string, number>();
    const revenueByKind = new Map<string, number>();
    const namesByKind = new Map<string, Set<string>>();

    for (const r of rows) {
      const resolved =
        ((r as { resolved_items?: Array<{ item_id: string; item_name_canonical: string; qty?: number }> })
          .resolved_items ?? []);
      if (resolved.length === 0) continue;
      const gross = r.gross_paid_gbp ?? 0;
      if (gross === 0) continue;
      const prices = resolved.map((x) => priceByName.get(x.item_name_canonical) ?? 0);
      const priceSum = prices.reduce((a, b) => a + b, 0);
      resolved.forEach((x, idx) => {
        const share =
          priceSum > 0 ? gross * (prices[idx] / priceSum) : gross / resolved.length;
        const k = kindById.get(x.item_id) ?? "unknown";
        countByKind.set(k, (countByKind.get(k) ?? 0) + (x.qty ?? 1));
        revenueByKind.set(k, (revenueByKind.get(k) ?? 0) + share);
        if (!namesByKind.has(k)) namesByKind.set(k, new Set());
        namesByKind.get(k)!.add(x.item_name_canonical);
      });
    }

    const entries = [...new Set([...countByKind.keys(), ...revenueByKind.keys()])]
      .map((k) => ({
        kind: k,
        count: countByKind.get(k) ?? 0,
        revenue: Math.round((revenueByKind.get(k) ?? 0) * 100) / 100,
        sample_names: [...(namesByKind.get(k) ?? new Set())].slice(0, 10),
      }))
      .sort((a, b) => b.count - a.count);

    const top6 = entries.slice(0, 6);
    const otherEntries = entries.slice(6);
    const otherTotal = otherEntries.reduce(
      (s, e) => ({ count: s.count + e.count, revenue: Math.round((s.revenue + e.revenue) * 100) / 100 }),
      { count: 0, revenue: 0 },
    );

    return {
      cutoff: cutoffStr,
      top_6: top6,
      other_entries: otherEntries,
      other_total: otherTotal,
    };
  },
});
