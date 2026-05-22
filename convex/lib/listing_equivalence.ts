/**
 * Listing → Inventory equivalence-class resolver.
 *
 * PURPOSE
 * Layered fallback for marketing-listing → MASTER_INVENTORY resolution:
 *
 *   (a) DIRECT  — already handled upstream by convex/listing_resolver.ts:resolveListing
 *                 (CANONICAL_MAP + AI scoring against MASTER_INVENTORY).
 *
 *   (b) EQUIVALENCE — when direct resolution returns null OR the matched SKU is
 *                     not in MASTER_INVENTORY, infer the CLOSEST AVAILABLE
 *                     equivalent by use-case. Daniel's canonical examples:
 *                       "GoPro"        → GoPro 12 Hero (owned) or DJI Osmo Action Pro 5 fallback
 *                       "FX3"          → Sony FX3 (owned) or Sony A7 V fallback
 *                       "BMPCC 6K Pro" → BMPCC 6K Pro (owned) or BMPCC 6K Full Frame fallback
 *
 * USED BY
 *   - Category Mix widget missed/demand/gap classification
 *     (DEMAND-GAP agent owns the wire-up in convex/revenue.ts:getMissedAndDeniedByCategory)
 *   - Circle item tracker (per-item / item utilization) — wired here so a denied
 *     "GoPro" request still contributes to the GoPro 12 Hero (or fallback) circle.
 *   - Listing resolver Tier 6.5 (convex/listing_resolver.ts) — auto-maps
 *     unresolved listings to closest equivalent before falling to pending_review.
 *
 * EDITING (EQ-A)
 * Map is now SETTINGS-BACKED. Daniel can edit at runtime via
 *   updateEquivalenceMap mutation (convex/listing_equivalence_admin.ts).
 * The in-code DEFAULT_LISTING_EQUIVALENCE_MAP below is the fallback when no
 * settings override is present. Existing tests run against the default map.
 *
 * Keywords are case-insensitive substrings checked against the listing title.
 * Candidate SKUs are the EXACT canonical names from MASTER_INVENTORY
 * (convex/lib/item_matcher.ts:MASTER_INVENTORY). The first candidate present
 * in the live owned-SKU set wins.
 */

import { MASTER_INVENTORY_KEYS } from "./item_matcher";

/**
 * EQ-A: in-code DEFAULT equivalence map. Used when settings.listing_equivalence_map
 * is missing/empty. Editable at runtime via the admin mutation.
 *
 * Exported as both `DEFAULT_LISTING_EQUIVALENCE_MAP` (preferred new alias) and
 * `LISTING_EQUIVALENCE_MAP` (legacy back-compat alias) so existing callers and
 * tests keep working.
 */
export const DEFAULT_LISTING_EQUIVALENCE_MAP: Record<string, string[]> = {
  // ── Action cams ──────────────────────────────────────────────────────
  "gopro": ["GoPro 12 Hero", "DJI Osmo Action Pro 5"],
  "go pro": ["GoPro 12 Hero", "DJI Osmo Action Pro 5"],
  "osmo action": ["DJI Osmo Action Pro 5", "GoPro 12 Hero"],
  "action cam": ["DJI Osmo Action Pro 5", "GoPro 12 Hero"],
  "action camera": ["DJI Osmo Action Pro 5", "GoPro 12 Hero"],

  // ── Sony cinema / mirrorless bodies ──────────────────────────────────
  "fx3": ["Sony FX3", "Sony A7 V", "Sony A7 III"],
  "fx 3": ["Sony FX3", "Sony A7 V", "Sony A7 III"],
  "sony fx": ["Sony FX3", "Sony A7 V"],
  "a7 v": ["Sony A7 V", "Sony FX3", "Sony A7 III"],
  "a7v": ["Sony A7 V", "Sony FX3", "Sony A7 III"],
  "a7 iv": ["Sony A7 V", "Sony FX3", "Sony A7 III"],
  "a7iv": ["Sony A7 V", "Sony FX3", "Sony A7 III"],
  "a7 iii": ["Sony A7 III", "Sony A7 V", "Sony FX3"],
  "a7iii": ["Sony A7 III", "Sony A7 V", "Sony FX3"],
  "a7 ii": ["Sony A7 II", "Sony A7 III"],
  "a7ii": ["Sony A7 II", "Sony A7 III"],
  "fx30": ["Sony FX3", "Sony A7 V"],
  "fx 30": ["Sony FX3", "Sony A7 V"],

  // ── Blackmagic cinema ────────────────────────────────────────────────
  "bmpcc 6k pro": ["BMPCC 6K Pro", "BMPCC 6K Full Frame"],
  "bmpcc 6k full frame": ["BMPCC 6K Full Frame", "BMPCC 6K Pro"],
  "bmpcc 6k": ["BMPCC 6K Pro", "BMPCC 6K Full Frame"],
  "bmpcc": ["BMPCC 6K Pro", "BMPCC 6K Full Frame"],
  "blackmagic pocket": ["BMPCC 6K Pro", "BMPCC 6K Full Frame"],
  "blackmagic 6k": ["BMPCC 6K Pro", "BMPCC 6K Full Frame"],
  "pyxis": ["BMPCC 6K Full Frame", "BMPCC 6K Pro"],

  // ── Power stations ──────────────────────────────────────────────────
  "anker power": ["Anker Power Station F2000"],
  "anker f2000": ["Anker Power Station F2000"],
  "power station": ["Anker Power Station F2000"],
  "portable power": ["Anker Power Station F2000"],
  "ecoflow": ["Anker Power Station F2000"],
  "jackery": ["Anker Power Station F2000"],

  // ── Drones ──────────────────────────────────────────────────────────
  "mavic 3": ["DJI Mavic 3 Pro", "DJI Mini 4 Pro"],
  "mavic": ["DJI Mavic 3 Pro", "DJI Mini 4 Pro"],
  "mini 4": ["DJI Mini 4 Pro", "DJI Mavic 3 Pro"],
  "dji drone": ["DJI Mavic 3 Pro", "DJI Mini 4 Pro"],

  // ── Wireless mics ───────────────────────────────────────────────────
  "dji mic": ["DJI Mic 2 wireless", "DJI Wireless Mics", "Rode Wireless Mic Pro set"],
  "rode wireless": ["Rode Wireless Mic Pro set", "DJI Mic 2 wireless"],
  "lavalier": ["DJI Mic 2 wireless", "Rode Wireless Mic Pro set", "DJI Wireless Mics"],
};

/**
 * Back-compat alias. Existing callers and tests import the old name.
 * Prefer DEFAULT_LISTING_EQUIVALENCE_MAP in new code.
 */
export const LISTING_EQUIVALENCE_MAP = DEFAULT_LISTING_EQUIVALENCE_MAP;

export type EquivalenceMatchType = "direct" | "equivalence" | "none";

export interface EquivalenceResult {
  sku: string | null;
  matchType: EquivalenceMatchType;
}

/**
 * Resolve a marketing listing to an owned MASTER_INVENTORY SKU using the
 * in-code DEFAULT map. Kept for back-compat — new callers should use
 * `loadEquivalenceMap(ctx)` + `resolveListingToInventoryWithMap` to honor the
 * settings-backed override.
 */
export function resolveListingToInventory(
  listingTitle: string,
  directMappedSku: string | null,
  ownedSkus: Set<string>,
): EquivalenceResult {
  return resolveListingToInventoryWithMap(
    listingTitle,
    directMappedSku,
    ownedSkus,
    DEFAULT_LISTING_EQUIVALENCE_MAP,
  );
}

/**
 * EQ-A: pure resolver variant that takes the equivalence map explicitly.
 * Keeps this helper testable (no DB reads). Callers in Convex queries load
 * the effective map once via `loadEquivalenceMap(ctx)` and pass it in.
 */
export function resolveListingToInventoryWithMap(
  listingTitle: string,
  directMappedSku: string | null,
  ownedSkus: Set<string>,
  map: Record<string, string[]>,
): EquivalenceResult {
  if (directMappedSku && ownedSkus.has(directMappedSku)) {
    return { sku: directMappedSku, matchType: "direct" };
  }
  const lc = (listingTitle ?? "").toLowerCase();
  if (!lc) return { sku: null, matchType: "none" };
  for (const [keyword, candidates] of Object.entries(map)) {
    if (lc.includes(keyword)) {
      const owned = candidates.find((sku) => ownedSkus.has(sku));
      if (owned) return { sku: owned, matchType: "equivalence" };
    }
  }
  return { sku: null, matchType: "none" };
}

/**
 * EQ-A: load the effective equivalence map from settings, falling back to
 * the in-code DEFAULT when the settings row is missing or has no override.
 *
 * Accepts a minimal ctx shape — works for QueryCtx and MutationCtx (both have
 * `db.query("settings").first()`). Action callers (no ctx.db) should call
 * `internal.listing_equivalence_admin.getEffectiveEquivalenceMap` via
 * ctx.runQuery instead.
 */
export async function loadEquivalenceMap(
  ctx: { db: { query: (name: "settings") => { first: () => Promise<{ listing_equivalence_map?: Record<string, string[]> } | null> } } },
): Promise<Record<string, string[]>> {
  try {
    const settings = await ctx.db.query("settings").first();
    const override = settings?.listing_equivalence_map;
    if (override && typeof override === "object" && Object.keys(override).length > 0) {
      return override;
    }
  } catch {
    // settings table missing or read failed — fall through to default
  }
  return DEFAULT_LISTING_EQUIVALENCE_MAP;
}

/**
 * DEV ASSERT: validate every candidate SKU in DEFAULT_LISTING_EQUIVALENCE_MAP
 * is a real MASTER_INVENTORY key. Throws on import in dev if any typo.
 */
export function validateEquivalenceMap(): { ok: boolean; errors: string[] } {
  const valid = new Set(MASTER_INVENTORY_KEYS);
  const errors: string[] = [];
  for (const [keyword, candidates] of Object.entries(DEFAULT_LISTING_EQUIVALENCE_MAP)) {
    for (const sku of candidates) {
      if (!valid.has(sku)) {
        errors.push(`"${keyword}" → "${sku}" not in MASTER_INVENTORY`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}
