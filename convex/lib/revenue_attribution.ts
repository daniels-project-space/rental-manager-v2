/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Revenue Attribution Engine — Phase 1.
 *  Pure module: no Convex db handles, no side effects.
 *  Single source of truth for value-weighted revenue split across line items.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Today's attribution (canonical at `convex/dashboard.ts:1511-1512`,
 * duplicated at 1663, 1761, and `convex/items.ts:75`) splits rental gross
 * across `resolved_items` by `pricing_catalog.daily_price_min`, equal-split
 * fallback. This module replaces that math with a 6-rule cascade that:
 *
 *   1. Prefers `expanded_items` (bundle-decomposed) over `resolved_items`.
 *   2. Excludes marketing-only items.
 *   3. Builds an "included set" from every present item's
 *      `compatibility.included_with_rental` array (canonical names).
 *   4. Per line: included accessories of kinds in STANDARD_INCLUDED_KINDS
 *      get £0; everything else gets a weight in the cascade:
 *        replacement_cost_gbp → daily_price * duration_days → 1 (equal fallback).
 *   5. Normalizes shares to sum exactly to gross (±1p) by re-adding the
 *      rounding drift onto the largest-weight line.
 *
 * Addon detection (Phase 5 — see plan section 1b risk #1):
 * `expanded_items` rows currently expose `{ item_id, item_name_canonical, qty,
 * via_bundle }` only. There is NO `source` field, so Phase 1 cannot
 * distinguish a body-only listing's "ND filter sold as add-on" from a kit-
 * decomposed ND filter. Behavior: items in the included set whose kind is
 * NOT in STANDARD_INCLUDED_KINDS still get full weight (preserves
 * legacy behavior — lenses/ND/etc. don't lose their share). Items in the
 * included set AND in STANDARD_INCLUDED_KINDS get £0.
 *
 * TODO Phase 5: once expanded_items.source ("bundle" | "addon" | "raw")
 * exists, an `addon_full` branch can promote add-on-purchased batteries back
 * to full weight even when they sit in the parent's included list.
 */

import type { Doc, Id } from "../_generated/dataModel";
import {
  ITEM_KINDS,
  STANDARD_INCLUDED_KINDS,
  normalizeKind,
  type ItemKind,
} from "./item_taxonomy";

// Re-export so callers can import the typed union from one place.
export { ITEM_KINDS, STANDARD_INCLUDED_KINDS, normalizeKind };
export type { ItemKind };

// ──────────────────────────────────────────────────────────────────────────
// Canonical money constants (Wave 1.4 — single source of truth).
// Mirrors src/mastra/data/constants.ts. Every Convex module that needs to
// convert gross → net-to-owner MUST import OWNER_SHARE from here rather than
// redefining a local literal.
// ──────────────────────────────────────────────────────────────────────────

/** Hygglo platform fee fraction (~36%). */
export const PLATFORM_FEE_SHARE = 0.36;

/** Owner take-home fraction after platform fee (1 - PLATFORM_FEE_SHARE). */
export const OWNER_SHARE = 0.64;

/**
 * Per-rental whole NET take-home. Prefers explicit `net_to_owner_gbp` when the
 * sync layer captured it; otherwise applies the platform-fee fallback.
 */
export function netOfTotal(r: {
  net_to_owner_gbp?: number | null;
  gross_paid_gbp?: number | null;
  gross_gbp?: number | null;
}): number {
  const explicit = r.net_to_owner_gbp;
  if (typeof explicit === "number") return explicit;
  const gross = r.gross_paid_gbp ?? r.gross_gbp ?? 0;
  return gross * OWNER_SHARE;
}

// ──────────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────────

/** Identifier for one line item on a rental. */
export type ItemKey = {
  id?: Id<"items">;
  nameCanonical: string;
};

/** Bundle-decomposed line shape (matches schema `expanded_items[*]`). */
export type ExpandedItem = {
  item_id: Id<"items">;
  item_name_canonical: string;
  qty: number;
  via_bundle?: Id<"bundles">;
};

/** LLM-resolved line shape (matches schema `resolved_items[*]`). */
export type ResolvedItem = {
  item_id: Id<"items">;
  item_name_canonical: string;
  confidence?: number;
  qty?: number;
  revenue_gbp?: number;
};

/** Raw Hygglo line (free-text). */
export type RawItem = {
  item_name?: string;
  qty?: number;
};

/** Minimal reservation shape consumed by the engine. */
export type RentalForAttribution = {
  _id: Id<"reservations">;
  gross_gbp: number;
  duration_days?: number;
  expanded_items?: ExpandedItem[];
  resolved_items?: ResolvedItem[];
  items?: RawItem[];
  /**
   * 2026-05-24: listing info pool override.
   * When provided (caller has resolved hygglo_items[].product_id ->
   * pool.bundle_components and the per-account flag is ON), this field
   * takes precedence over expanded_items / resolved_items / items so
   * attribution math runs over the same components used by
   * double-booking + out-of-stock. Caller is responsible for the
   * feature-flag check; engine treats this as authoritative.
   */
  pool_override?: Array<{
    item_id: Id<"items">;
    item_name_canonical: string;
    qty: number;
  }>;
};

/**
 * Context maps. Built once per query and passed in. Keeps the engine pure
 * (no `ctx.db` calls) for unit-testability and so the same code can run in
 * dry-run preview, production migration, and per-rental drill-downs.
 */
export type AttributionContext = {
  itemById: Map<Id<"items">, Doc<"items">>;
  itemByCanonical: Map<string, Doc<"items">>;
  /** daily_price_min from pricing_catalog, keyed by item_name_canonical. */
  priceByName: Map<string, number>;
};

export type AttributionReason =
  | "weighted_replacement"
  | "weighted_daily_price"
  | "equal_split"
  | "included_zero"
  | "addon_full"
  | "marketing_only_excluded";

export type AttributionLine = {
  key: ItemKey;
  kind: ItemKind;
  weight: number;
  /** Attributed £; shares across the rental sum to gross_gbp ±0.01. */
  share: number;
  reason: AttributionReason;
};

// ──────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────

/** Round to 2 decimal places (banker-safe enough for £ amounts). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

type LineSource = {
  item_id?: Id<"items">;
  item_name_canonical: string;
  qty: number;
};

/**
 * Choose the line array in priority order: expanded → resolved → raw.
 * Mirrors `dashboard.ts:1434 readResolverItems` plus a `raw items[]` fallback.
 */
function pickLines(r: RentalForAttribution): LineSource[] {
  if (r.pool_override && r.pool_override.length > 0) {
    return r.pool_override.map((x) => ({
      item_id: x.item_id,
      item_name_canonical: x.item_name_canonical,
      qty: x.qty,
    }));
  }
  if (r.expanded_items && r.expanded_items.length > 0) {
    return r.expanded_items.map((x) => ({
      item_id: x.item_id,
      item_name_canonical: x.item_name_canonical,
      qty: x.qty,
    }));
  }
  if (r.resolved_items && r.resolved_items.length > 0) {
    return r.resolved_items.map((x) => ({
      item_id: x.item_id,
      item_name_canonical: x.item_name_canonical,
      qty: x.qty ?? 1,
    }));
  }
  if (r.items && r.items.length > 0) {
    return r.items.map((x) => ({
      item_id: undefined,
      item_name_canonical: (x.item_name ?? "").trim(),
      qty: x.qty ?? 1,
    }));
  }
  return [];
}

/**
 * Build the "included set" of canonical names: union of
 * `compatibility.included_with_rental` arrays across every line whose
 * resolved item has one. These are the items considered "standard
 * accessories of something present on the rental".
 *
 * Returns the union and (for diagnostics) a list of names referenced by
 * `included_with_rental` that do not appear in `itemByCanonical` (Phase 2
 * feeds these into seed-data correction).
 */
export function buildIncludedSet(
  lines: LineSource[],
  ctx: AttributionContext,
): { set: Set<string>; unmatched: string[] } {
  const set = new Set<string>();
  const unmatched: string[] = [];
  for (const ln of lines) {
    const it = ln.item_id ? ctx.itemById.get(ln.item_id) : ctx.itemByCanonical.get(ln.item_name_canonical);
    if (!it) continue;
    const incl = it.compatibility?.included_with_rental ?? [];
    for (const name of incl) {
      set.add(name);
      if (!ctx.itemByCanonical.has(name)) {
        unmatched.push(name);
      }
    }
  }
  return { set, unmatched };
}

// ──────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────

/**
 * Attribute a rental's gross_gbp across its line items.
 *
 * Pure function — no db calls, no logging side effects (callers handle
 * unmatched-name warnings).
 *
 * Guarantees:
 *   - sum(line.share for line in result) === rental.gross_gbp ±0.01
 *   - result.length === pickLines(rental).length (one line out per line in)
 *   - empty input (no expanded/resolved/raw items) → returns []
 */
export function attributeRevenue(
  rental: RentalForAttribution,
  ctx: AttributionContext,
): AttributionLine[] {
  const lines = pickLines(rental);
  if (lines.length === 0) return [];

  const gross = rental.gross_gbp ?? 0;
  const durationDays = Math.max(1, rental.duration_days ?? 1);
  const { set: includedSet } = buildIncludedSet(lines, ctx);

  // Pass 1 — assign per-line reason, weight, kind.
  const draft: AttributionLine[] = lines.map((ln) => {
    const it = ln.item_id ? ctx.itemById.get(ln.item_id) : ctx.itemByCanonical.get(ln.item_name_canonical);
    const rawKind = it?.kind;
    const kind: ItemKind = it ? normalizeKind(rawKind) : "unknown";
    const key: ItemKey = {
      id: ln.item_id,
      nameCanonical: ln.item_name_canonical,
    };

    // Rule 1: marketing-only exclusion.
    if (it?.is_marketing_only) {
      return { key, kind: "marketing_only", weight: 0, share: 0, reason: "marketing_only_excluded" };
    }

    // Rule 2: included accessory of standard kind → £0.
    // Match by canonical name (Phase 1 has no addon-source flag — see top-of-
    // file note re Phase 5 promotion path).
    const inIncluded = includedSet.has(ln.item_name_canonical);
    if (inIncluded && STANDARD_INCLUDED_KINDS.has(kind)) {
      return { key, kind, weight: 0, share: 0, reason: "included_zero" };
    }

    // Rule 3: weight cascade.
    const repl = it?.replacement_cost_gbp;
    if (typeof repl === "number" && repl > 0) {
      return { key, kind, weight: repl * (ln.qty || 1), share: 0, reason: "weighted_replacement" };
    }
    const dailyPrice = ctx.priceByName.get(ln.item_name_canonical);
    if (typeof dailyPrice === "number" && dailyPrice > 0) {
      return {
        key,
        kind,
        weight: dailyPrice * durationDays * (ln.qty || 1),
        share: 0,
        reason: "weighted_daily_price",
      };
    }

    // Rule 4: equal-split fallback. Sentinel weight 1 so the normalize pass
    // distributes evenly across all equal_split lines.
    return { key, kind, weight: 1, share: 0, reason: "equal_split" };
  });

  // Pass 2 — normalize.
  const eligible = draft.filter((d) => d.weight > 0);
  const totalWeight = eligible.reduce((s, d) => s + d.weight, 0);

  if (eligible.length === 0 || totalWeight <= 0 || gross <= 0) {
    // No eligible weights (all marketing/included/zero) OR gross<=0. Nothing
    // to distribute — leave shares at 0.
    return draft;
  }

  for (const d of draft) {
    if (d.weight > 0) {
      d.share = round2(gross * (d.weight / totalWeight));
    }
  }

  // Pass 3 — rounding drift onto the largest-weight line.
  const sumShares = draft.reduce((s, d) => s + d.share, 0);
  const drift = round2(gross - sumShares);
  if (drift !== 0) {
    let largest = draft[0];
    for (const d of draft) {
      if (d.weight > largest.weight) largest = d;
    }
    if (largest.weight > 0) {
      largest.share = round2(largest.share + drift);
    }
  }

  return draft;
}
