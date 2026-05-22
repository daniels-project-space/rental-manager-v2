/**
 * Listing equivalence-map admin (EQ-A).
 *
 * Convex-side query + mutation surface for reading and updating the
 * runtime-editable equivalence map stored on the settings singleton.
 *
 *   getEffectiveEquivalenceMap  — public query, used by listing_resolver
 *                                 (Tier 6.5) which runs in `"use node"` and
 *                                 cannot touch ctx.db directly. Returns the
 *                                 settings override OR the in-code default
 *                                 (DEFAULT_LISTING_EQUIVALENCE_MAP) when the
 *                                 override is absent.
 *
 *   updateEquivalenceMap        — admin mutation, validates every candidate
 *                                 SKU against MASTER_INVENTORY before saving.
 *
 *   TODO admin auth: there is no project-wide admin-auth pattern yet
 *   (everything is internal-tools). This mutation is currently PUBLIC. Wrap
 *   in the admin-auth gate when introduced.
 */

import { v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
import {
  DEFAULT_LISTING_EQUIVALENCE_MAP,
} from "./lib/listing_equivalence";
import { MASTER_INVENTORY_KEYS } from "./lib/item_matcher";

/**
 * Internal-callable: returns the effective equivalence map. Used by the
 * `"use node"` listing_resolver Tier 6.5 fallback via ctx.runQuery.
 */
export const getEffectiveEquivalenceMap = internalQuery({
  args: {},
  handler: async (ctx): Promise<Record<string, string[]>> => {
    const settings = await ctx.db.query("settings").first();
    const override = settings?.listing_equivalence_map;
    if (override && typeof override === "object" && Object.keys(override).length > 0) {
      return override as Record<string, string[]>;
    }
    return DEFAULT_LISTING_EQUIVALENCE_MAP;
  },
});

/**
 * Public-callable variant for dashboard/admin UIs that want to display the
 * currently-effective map (override OR default).
 */
export const getEffectiveEquivalenceMapPublic = query({
  args: {},
  handler: async (ctx): Promise<Record<string, string[]>> => {
    const settings = await ctx.db.query("settings").first();
    const override = settings?.listing_equivalence_map;
    if (override && typeof override === "object" && Object.keys(override).length > 0) {
      return override as Record<string, string[]>;
    }
    return DEFAULT_LISTING_EQUIVALENCE_MAP;
  },
});

/**
 * Update (or clear) the runtime equivalence map on the settings singleton.
 * Validates every candidate SKU is a real MASTER_INVENTORY key before saving;
 * refuses the whole write if any SKU is invalid.
 *
 * Pass an empty map (`{}`) to clear the override and fall back to the in-code
 * DEFAULT_LISTING_EQUIVALENCE_MAP.
 *
 * TODO admin auth: currently public — gate when admin-auth pattern lands.
 */
export const updateEquivalenceMap = mutation({
  args: {
    map: v.record(v.string(), v.array(v.string())),
  },
  handler: async (ctx, { map }) => {
    // Validate every candidate SKU exists in MASTER_INVENTORY.
    const valid = new Set(MASTER_INVENTORY_KEYS);
    const errors: string[] = [];
    for (const [keyword, candidates] of Object.entries(map)) {
      if (keyword !== keyword.toLowerCase()) {
        errors.push(`keyword "${keyword}" must be lowercase`);
      }
      for (const sku of candidates) {
        if (!valid.has(sku)) {
          errors.push(`"${keyword}" → "${sku}" not in MASTER_INVENTORY`);
        }
      }
    }
    if (errors.length > 0) {
      throw new Error(
        `EQUIVALENCE_MAP_VALIDATION_FAILED: ${errors.slice(0, 8).join("; ")}` +
          (errors.length > 8 ? ` (+${errors.length - 8} more)` : ""),
      );
    }

    const existing = await ctx.db.query("settings").first();
    if (!existing) {
      throw new Error("No settings row found — seed the database first.");
    }
    // Empty map → clear the override (revert to in-code default).
    const patch: { listing_equivalence_map?: Record<string, string[]> | undefined; updated_at: number } = {
      updated_at: Date.now(),
      listing_equivalence_map: Object.keys(map).length === 0 ? undefined : map,
    };
    await ctx.db.patch(existing._id, patch);
    return {
      ok: true,
      keyword_count: Object.keys(map).length,
      cleared: Object.keys(map).length === 0,
    };
  },
});
