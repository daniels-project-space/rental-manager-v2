/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Dry-run preview query — side-by-side old vs new revenue attribution.
 *  Phase 1 only. NOT WIRED to any UI / widget — inspection tool only.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Daniel runs this query manually against a small batch (20-30 rentals) and
 * inspects the diff between the legacy attribution math (mirrored from
 * `convex/dashboard.ts:1510-1516`) and the new value-weighted engine in
 * `convex/lib/revenue_attribution.ts`. Phase 2 only proceeds after his sign-
 * off — production callers stay on legacy math until then.
 *
 * Read-only. No mutations, no writes, no schema changes.
 */

import { v } from "convex/values";
import { query } from "./_generated/server";

import type { Doc, Id } from "./_generated/dataModel";
import {
  dedupByLogicalRental,
  effectiveDate,
  isLive,
} from "./lib/reservations/predicates";
import {
  attributeRevenue,
  normalizeKind,
  type AttributionLine,
  type ItemKind,
  type RentalForAttribution,
} from "./lib/revenue_attribution";

// ──────────────────────────────────────────────────────────────────────────
// Legacy attribution — byte-faithful mirror of dashboard.ts:1500-1517.
// ──────────────────────────────────────────────────────────────────────────

type LegacyLine = {
  item_id: string;
  item_name_canonical: string;
  qty: number;
  kind: string;
  share: number;
};

/**
 * Mirror of the canonical legacy math from `convex/dashboard.ts:1500-1517`.
 * Quoted lines (for audit; do not paraphrase):
 *
 *   const resolved =
 *     (r as { resolved_items?: ... }).resolved_items ?? [];
 *   if (resolved.length === 0) continue;
 *   const gross = r.gross_paid_gbp ?? 0;
 *   const prices = resolved.map((x) => priceByCanonical.get(x.item_name_canonical) ?? 0);
 *   const priceSum = prices.reduce((a, b) => a + b, 0);
 *   resolved.forEach((x, idx) => {
 *     const share =
 *       priceSum > 0 ? gross * (prices[idx] / priceSum) : gross / resolved.length;
 *     const k = kindById.get(x.item_id) ?? "unknown";
 *     ...
 *   });
 *
 * Note: legacy reads `resolved_items` ONLY (it ignores `expanded_items`,
 * which is the C3 bug in the plan). The mirror preserves that behavior so
 * the diff isolates exactly what the new engine changes.
 */
function legacyAttribute(
  r: {
    gross_paid_gbp?: number;
    resolved_items?: Array<{ item_id: string; item_name_canonical: string; qty?: number }>;
  },
  priceByCanonical: Map<string, number>,
  kindById: Map<string, string>,
): LegacyLine[] {
  const resolved = r.resolved_items ?? [];
  if (resolved.length === 0) return [];
  const gross = r.gross_paid_gbp ?? 0;
  const prices = resolved.map((x) => priceByCanonical.get(x.item_name_canonical) ?? 0);
  const priceSum = prices.reduce((a, b) => a + b, 0);
  return resolved.map((x, idx) => {
    const share = priceSum > 0 ? gross * (prices[idx] / priceSum) : gross / resolved.length;
    const k = kindById.get(x.item_id) ?? "unknown";
    return {
      item_id: x.item_id,
      item_name_canonical: x.item_name_canonical,
      qty: x.qty ?? 1,
      kind: k,
      share: Math.round(share * 100) / 100,
    };
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Diff aggregation helpers
// ──────────────────────────────────────────────────────────────────────────

type PerLineDiff = {
  item_name_canonical: string;
  old_share: number;
  new_share: number;
  delta: number;
  old_kind: string;
  new_kind: ItemKind;
  new_reason: AttributionLine["reason"];
};

function buildDiff(oldLines: LegacyLine[], newLines: AttributionLine[]): PerLineDiff[] {
  // Match by canonical name. Some rentals may have items in `newLines` (from
  // expanded_items) that are absent from `oldLines` (which only reads
  // resolved_items) — those show up with old_share=0.
  const byName = new Map<string, PerLineDiff>();
  for (const o of oldLines) {
    byName.set(o.item_name_canonical, {
      item_name_canonical: o.item_name_canonical,
      old_share: o.share,
      new_share: 0,
      delta: 0,
      old_kind: o.kind,
      new_kind: "unknown",
      new_reason: "equal_split",
    });
  }
  for (const n of newLines) {
    const existing = byName.get(n.key.nameCanonical);
    if (existing) {
      existing.new_share = Math.round(n.share * 100) / 100;
      existing.new_kind = n.kind;
      existing.new_reason = n.reason;
    } else {
      byName.set(n.key.nameCanonical, {
        item_name_canonical: n.key.nameCanonical,
        old_share: 0,
        new_share: Math.round(n.share * 100) / 100,
        delta: 0,
        old_kind: "<absent>",
        new_kind: n.kind,
        new_reason: n.reason,
      });
    }
  }
  for (const d of byName.values()) {
    d.delta = Math.round((d.new_share - d.old_share) * 100) / 100;
  }
  return Array.from(byName.values()).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

// ──────────────────────────────────────────────────────────────────────────
// Public query
// ──────────────────────────────────────────────────────────────────────────

export const previewAttribution = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { accountSlug, limit = 30 }) => {
    // 1. Pull reservations for the account.
    const all = accountSlug === null
      ? await ctx.db.query("reservations").collect()
      : await ctx.db
          .query("reservations")
          .filter((q) => q.eq(q.field("account_slug"), accountSlug))
          .collect();

    // 2. Filter to live rows and dedup by logical rental key.
    //    `dedupByLogicalRental` is generic over ReservationRow; cast through
    //    `unknown` because the full Doc<"reservations"> has extra fields the
    //    structural ReservationRow type doesn't enumerate.
    type LooseRow = Parameters<typeof dedupByLogicalRental>[0][number];
    let rentals = (all as unknown as LooseRow[]).filter((r) => isLive(r));
    rentals = dedupByLogicalRental(rentals);

    // 3. Sort by effective date DESC, slice to limit.
    rentals.sort((a, b) => {
      const da = effectiveDate(a) ?? "";
      const db = effectiveDate(b) ?? "";
      return db.localeCompare(da);
    });
    const recent = rentals.slice(0, Math.max(1, limit));

    // 4. Build the three maps once.
    const items = await ctx.db.query("items").collect();
    const itemById = new Map<Id<"items">, Doc<"items">>();
    const itemByCanonical = new Map<string, Doc<"items">>();
    const kindById = new Map<string, string>();
    for (const it of items) {
      itemById.set(it._id, it);
      itemByCanonical.set(it.name_canonical, it);
      kindById.set(it._id as unknown as string, it.kind);
    }
    const pricingAll = await ctx.db.query("pricing_catalog").collect();
    const priceByCanonical = new Map<string, number>(
      pricingAll.map((p) => [p.item_name_canonical, p.daily_price_min]),
    );

    const attribCtx = {
      itemById,
      itemByCanonical,
      priceByName: priceByCanonical,
    };

    // 5. Per-rental: oldLines, newLines, diff.
    const perRental: Array<{
      rentalId: string;
      hyggloOrderId: string | undefined;
      date: string | undefined;
      gross: number;
      durationDays: number | undefined;
      oldLines: LegacyLine[];
      newLines: AttributionLine[];
      diff: PerLineDiff[];
      newSumOk: boolean;
    }> = [];

    // Aggregate (per ItemKind) — old vs new totals.
    const byKindOld = new Map<string, number>();
    const byKindNew = new Map<ItemKind, number>();

    const unmatchedIncludedNames = new Set<string>();

    for (const r of recent) {
      const gross = (r as { gross_paid_gbp?: number }).gross_paid_gbp ?? 0;
      const rForAttrib: RentalForAttribution = {
        _id: r._id as Id<"reservations">,
        gross_gbp: gross,
        duration_days: (r as { duration_days?: number }).duration_days,
        expanded_items: (r as { expanded_items?: RentalForAttribution["expanded_items"] }).expanded_items,
        resolved_items: (r as { resolved_items?: RentalForAttribution["resolved_items"] }).resolved_items,
      };

      const oldLines = legacyAttribute(
        {
          gross_paid_gbp: gross,
          resolved_items: (r as { resolved_items?: LegacyLine[] }).resolved_items?.map((x) => ({
            item_id: (x as { item_id: Id<"items"> | string }).item_id as unknown as string,
            item_name_canonical: x.item_name_canonical,
            qty: x.qty,
          })),
        },
        priceByCanonical,
        kindById,
      );

      const newLines = attributeRevenue(rForAttrib, attribCtx);

      // Log unmatched included_with_rental names (Phase 2 seed-correction
      // feedback). We re-derive included set inline to avoid an export.
      for (const ln of newLines) {
        const it = ln.key.id ? itemById.get(ln.key.id) : itemByCanonical.get(ln.key.nameCanonical);
        const incl = it?.compatibility?.included_with_rental ?? [];
        for (const name of incl) {
          if (!itemByCanonical.has(name)) {
            unmatchedIncludedNames.add(name);
          }
        }
      }

      const newSum = Math.round(newLines.reduce((s, l) => s + l.share, 0) * 100) / 100;
      const newSumOk = Math.abs(newSum - Math.round(gross * 100) / 100) <= 0.01;

      // Aggregate per-kind totals.
      for (const o of oldLines) {
        byKindOld.set(o.kind, (byKindOld.get(o.kind) ?? 0) + o.share);
      }
      for (const n of newLines) {
        byKindNew.set(n.kind, (byKindNew.get(n.kind) ?? 0) + n.share);
      }

      perRental.push({
        rentalId: r._id as unknown as string,
        hyggloOrderId: (r as { hygglo_order_id?: string }).hygglo_order_id,
        date: effectiveDate(r),
        gross,
        durationDays: (r as { duration_days?: number }).duration_days,
        oldLines,
        newLines,
        diff: buildDiff(oldLines, newLines),
        newSumOk,
      });
    }

    if (unmatchedIncludedNames.size > 0) {
      console.warn(
        "[previewAttribution] unmatched included_with_rental names (Phase 2 feedback):",
        Array.from(unmatchedIncludedNames),
      );
    }

    const byKind = {
      old: Object.fromEntries(
        Array.from(byKindOld.entries()).map(([k, v]) => [k, Math.round(v * 100) / 100]),
      ),
      new: Object.fromEntries(
        Array.from(byKindNew.entries()).map(([k, v]) => [k, Math.round(v * 100) / 100]),
      ),
    };

    return {
      accountSlug,
      sampledCount: perRental.length,
      perRental,
      byKind,
      unmatchedIncludedNames: Array.from(unmatchedIncludedNames),
      notes: [
        "Phase 1 dry-run preview — read-only, no production caller.",
        "oldLines: byte-faithful mirror of dashboard.ts:1500-1517 (reads resolved_items only).",
        "newLines: value-weighted engine (lib/revenue_attribution.ts) — replacement_cost primary.",
        "newSumOk: true iff sum(newLines.share) === gross_gbp ±0.01.",
      ],
    };
  },
});

// Silence "unused import" if normalizeKind is only re-exported for type-side
// consumers (it's referenced indirectly through ItemKind).
void normalizeKind;
