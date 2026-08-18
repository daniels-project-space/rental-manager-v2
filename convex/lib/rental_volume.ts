/**
 * Shared rental-volume attribution pipeline (Wave 9 dedup).
 *
 * `getRentalVolumeByCategory`, `getRentalVolumeKindBreakdown` and
 * `getRentalVolumeOtherSubKinds` (convex/dashboard.ts) each inlined an
 * IDENTICAL prelude:
 *
 *   reservations by_start_date >= cutoff
 *     → account filter
 *     → isLive
 *     → dedupByLogicalRental
 *     → effectiveDate window [cutoffStr, todayStr]
 *     → pricing_catalog / items / listing_resolution_override map build
 *     → per-reservation attributeRevenue() loop
 *
 * Three copies meant a correction to the dedup or attribution semantics could
 * land in one and silently drift from the other two — the dashboard would then
 * show category totals that disagree with their own drill-downs. Same bug class
 * as the calendar renter-lookup duplication fixed in Wave 6.
 *
 * This module is a PURE EXTRACTION: every statement below is copied verbatim
 * from the previous inline bodies, in the same order, so output is unchanged.
 * Each caller keeps its own final grouping/presentation step, which is the only
 * part that genuinely differed.
 */
import type { QueryCtx } from "../_generated/server";
import {
  dedupByLogicalRental,
  effectiveDate,
  isLive,
} from "./reservations/predicates";
import {
  attributeRevenue,
  overridePoolForReservation,
  type RentalForAttribution,
} from "./revenue_attribution";

const KIND_LABELS: Record<string, string> = {
  camera: "Cameras", lens: "Lenses", drone: "Drones", audio: "Audio",
  lighting: "Lighting", grip: "Grip", gimbal: "Gimbals", monitor: "Monitors",
  transmission: "Transmission", accessory: "Accessories", smoke_fx: "Smoke/FX",
  dj_audio: "DJ Audio", power: "Power", storage_card: "Storage", support: "Support",
  motion: "Motion", stabilizer: "Stabilizers", video: "Video", effects: "Effects",
  bundle: "Bundles", unknown: "Unknown", other: "Other",
};

/** Human label for an item kind; Title-Cases unknown kinds as a fallback. */
export const labelFor = (k: string): string =>
  KIND_LABELS[k] ?? (k.charAt(0).toUpperCase() + k.slice(1));

/** One line emitted by the attribution engine. */
type AttributionLine = ReturnType<typeof attributeRevenue>[number];

/**
 * Loads the reservation window plus every lookup map the attribution engine
 * needs. Verbatim lift of the shared prelude from all three volume queries.
 *
 * NOTE the DB read order (reservations → pricing_catalog → items →
 * listing_resolution_override) matches the previous inline copies. Convex
 * queries run against a single consistent snapshot, so ordering carries no
 * semantic weight, but it is preserved to keep the diff auditable.
 */
export async function loadRentalVolumeWindow(
  ctx: QueryCtx,
  accountSlug: string | null,
  days: number,
) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  let reservations = await ctx.db
    .query("reservations")
    .withIndex("by_start_date", (q) => q.gte("start_date", cutoffStr))
    .collect();
  if (accountSlug) {
    reservations = reservations.filter((r) => r.account_slug === accountSlug);
  }
  // Match revenue.ts semantics: drop cancelled/declined/obsolete, then
  // collapse v1/Hygglo duplicates, then restrict to effectiveDate window.
  reservations = reservations.filter(isLive);
  reservations = dedupByLogicalRental(reservations);
  const todayStr = new Date().toISOString().slice(0, 10);
  reservations = reservations.filter((r) => {
    const d = effectiveDate(r);
    return d !== undefined && d >= cutoffStr && d <= todayStr;
  });

  // Pricing catalog for revenue split weights (canonical → daily_price_min).
  const pricingAll = await ctx.db.query("pricing_catalog").collect();
  const priceByCanonical = new Map<string, number>(
    pricingAll.map((p) => [p.item_name_canonical, p.daily_price_min]),
  );

  const items = await ctx.db.query("items").collect();

  // Phase 6 — attribution engine is the only path. Maps built once, reused.
  const itemById = new Map<typeof items[number]["_id"], typeof items[number]>();
  const itemByCanonical = new Map<string, typeof items[number]>();
  for (const it of items) {
    itemById.set(it._id, it);
    const nm = (it as { name_canonical?: string }).name_canonical;
    if (nm) itemByCanonical.set(nm, it);
  }
  const nameByIdStr = new Map<string, string>();
  for (const it of items) { const nmx = (it as { name_canonical?: string }).name_canonical; if (nmx) nameByIdStr.set(String(it._id), nmx); }
  const overrideByProduct = new Map<string, Array<{ item_id: string; qty: number }>>();
  for (const o of await ctx.db.query("listing_resolution_override").collect()) overrideByProduct.set(`${o.account_slug}#${o.product_id}`, o.components.map((c) => ({ item_id: String(c.item_id), qty: c.qty })));

  return {
    cutoffStr,
    reservations,
    items,
    priceByCanonical,
    itemById,
    itemByCanonical,
    nameByIdStr,
    overrideByProduct,
  };
}

export type RentalVolumeWindow = Awaited<ReturnType<typeof loadRentalVolumeWindow>>;

/**
 * Runs the attribution engine over every reservation in the window and hands
 * each emitted line to `visit`. Reservations with no resolved_items are skipped
 * (unchanged from the inline copies).
 */
export function forEachAttributionLine(
  window: RentalVolumeWindow,
  visit: (line: AttributionLine) => void,
): void {
  for (const r of window.reservations) {
    const resolved =
      (r as {
        resolved_items?: Array<{ item_id: string; item_name_canonical: string; qty?: number }>;
      }).resolved_items ?? [];
    if (resolved.length === 0) continue;

    const rental: RentalForAttribution = {
      _id: r._id,
      gross_gbp: r.gross_paid_gbp ?? 0,
      duration_days: r.duration_days,
      expanded_items: (r as { expanded_items?: RentalForAttribution["expanded_items"] }).expanded_items,
      resolved_items: resolved as RentalForAttribution["resolved_items"],
      pool_override: overridePoolForReservation(r as { account_slug?: string; hygglo_items?: Array<{ product_id?: number; qty?: number }> }, window.overrideByProduct, (id) => window.nameByIdStr.get(id)),
    };
    const lines = attributeRevenue(rental, {
      itemById: window.itemById,
      itemByCanonical: window.itemByCanonical,
      priceByName: window.priceByCanonical,
    });
    for (const line of lines) visit(line);
  }
}

export type KindEntry = {
  kind: string;
  label: string;
  count: number;
  revenue: number;
};

/**
 * Per-kind roll-up shared by getRentalVolumeByCategory and
 * getRentalVolumeOtherSubKinds — both previously built this identically.
 *
 * `revenue` is deliberately left UNROUNDED: both callers round only at slice
 * assembly time, and getRentalVolumeByCategory sums the unrounded values for
 * its pre-truncation `totals`. Rounding here would change published numbers.
 */
export function aggregateKindEntries(window: RentalVolumeWindow): KindEntry[] {
  const countByKind = new Map<string, number>();
  const revenueByKind = new Map<string, number>();

  forEachAttributionLine(window, (line) => {
    const k = line.kind;
    // One AttributionLine per input pickLines entry; count is per source line.
    countByKind.set(k, (countByKind.get(k) ?? 0) + 1);
    revenueByKind.set(k, (revenueByKind.get(k) ?? 0) + line.share);
  });

  // Assemble entries (any kind with count>0 OR revenue>0).
  const kinds = new Set<string>([...countByKind.keys(), ...revenueByKind.keys()]);
  return Array.from(kinds)
    .map((k) => ({
      kind: k,
      label: labelFor(k),
      count: countByKind.get(k) ?? 0,
      revenue: revenueByKind.get(k) ?? 0,
    }))
    .filter((e) => e.count > 0 || e.revenue > 0)
    .sort((a, b) => b.count - a.count);
}
