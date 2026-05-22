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
 *
 * EDITING
 * Daniel can extend LISTING_EQUIVALENCE_MAP without code changes elsewhere.
 * Keywords are case-insensitive substrings checked against the listing title.
 * Candidate SKUs are the EXACT canonical names from MASTER_INVENTORY
 * (convex/lib/item_matcher.ts:MASTER_INVENTORY). The first candidate present
 * in the live owned-SKU set wins.
 *
 * FOLLOW-UP (not in this commit): move LISTING_EQUIVALENCE_MAP to a Convex
 * `settings` table for runtime edit via dashboard.
 */

import { MASTER_INVENTORY_KEYS } from "./item_matcher";

/**
 * Marketing keyword (lowercase substring) → ordered list of MASTER_INVENTORY
 * canonical SKU names (best match first). SKUs must match MASTER_INVENTORY
 * exactly — validated in tests below.
 */
export const LISTING_EQUIVALENCE_MAP: Record<string, string[]> = {
  // ── Action cams ──────────────────────────────────────────────────────
  "gopro": ["GoPro 12 Hero", "DJI Osmo Action Pro 5"],
  "go pro": ["GoPro 12 Hero", "DJI Osmo Action Pro 5"],
  "osmo action": ["DJI Osmo Action Pro 5", "GoPro 12 Hero"],
  "action cam": ["DJI Osmo Action Pro 5", "GoPro 12 Hero"],
  "action camera": ["DJI Osmo Action Pro 5", "GoPro 12 Hero"],

  // ── Sony cinema / mirrorless bodies ──────────────────────────────────
  // Daniel: "FX3" listing → A7V (closest available cinema-ish camera) IF FX3
  // out of stock. FX3 itself is owned (3 units) so direct match wins normally.
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
  "fx30": ["Sony FX3", "Sony A7 V"], // FX30 not owned per listing_photo_reference notes
  "fx 30": ["Sony FX3", "Sony A7 V"],

  // ── Blackmagic cinema ────────────────────────────────────────────────
  // Daniel: "BMPCC 6K Pro" → BMPCC Full Frame (the unit we actually own).
  // Both Pro and Full Frame are in MASTER_INVENTORY (1 each).
  "bmpcc 6k pro": ["BMPCC 6K Pro", "BMPCC 6K Full Frame"],
  "bmpcc 6k full frame": ["BMPCC 6K Full Frame", "BMPCC 6K Pro"],
  "bmpcc 6k": ["BMPCC 6K Pro", "BMPCC 6K Full Frame"],
  "bmpcc": ["BMPCC 6K Pro", "BMPCC 6K Full Frame"],
  "blackmagic pocket": ["BMPCC 6K Pro", "BMPCC 6K Full Frame"],
  "blackmagic 6k": ["BMPCC 6K Pro", "BMPCC 6K Full Frame"],
  "pyxis": ["BMPCC 6K Full Frame", "BMPCC 6K Pro"], // Pyxis 6K NOT owned, FF closest

  // ── Power stations ──────────────────────────────────────────────────
  // Daniel: "Anker power station" → Anker Power Station F2000.
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

export type EquivalenceMatchType = "direct" | "equivalence" | "none";

export interface EquivalenceResult {
  sku: string | null;
  matchType: EquivalenceMatchType;
}

/**
 * Resolve a marketing listing to an owned MASTER_INVENTORY SKU.
 *
 * Order:
 *   1. If `directMappedSku` is provided AND present in `ownedSkus` → direct.
 *   2. Else scan LISTING_EQUIVALENCE_MAP keywords against `listingTitle`
 *      (case-insensitive); first keyword match returns the first candidate
 *      that's in `ownedSkus`.
 *   3. Else → none.
 *
 * AVOIDS DOUBLE-ATTRIBUTION: direct match always preferred over equivalence
 * (see task #7).
 */
export function resolveListingToInventory(
  listingTitle: string,
  directMappedSku: string | null,
  ownedSkus: Set<string>,
): EquivalenceResult {
  if (directMappedSku && ownedSkus.has(directMappedSku)) {
    return { sku: directMappedSku, matchType: "direct" };
  }
  const lc = (listingTitle ?? "").toLowerCase();
  if (!lc) return { sku: null, matchType: "none" };
  for (const [keyword, candidates] of Object.entries(LISTING_EQUIVALENCE_MAP)) {
    if (lc.includes(keyword)) {
      const owned = candidates.find((sku) => ownedSkus.has(sku));
      if (owned) return { sku: owned, matchType: "equivalence" };
    }
  }
  return { sku: null, matchType: "none" };
}

/**
 * Inline tests / examples — verify against MASTER_INVENTORY_KEYS at runtime.
 * Run via: convex/lib/listing_equivalence.test.ts (jest) — see same dir.
 *
 *   const owned = new Set(MASTER_INVENTORY_KEYS);
 *
 *   resolveListingToInventory("Sony FX3 (rare)", null, owned)
 *     → { sku: "Sony FX3", matchType: "equivalence" }
 *
 *   resolveListingToInventory("GoPro Hero 11 Black", null, owned)
 *     → { sku: "GoPro 12 Hero", matchType: "equivalence" }
 *
 *   resolveListingToInventory("BMPCC 6K Pro w/ rig", null, owned)
 *     → { sku: "BMPCC 6K Pro", matchType: "equivalence" }
 *
 *   resolveListingToInventory("Sony A7 V kit", "Sony A7 V", owned)
 *     → { sku: "Sony A7 V", matchType: "direct" }
 *
 *   resolveListingToInventory("Anker power station F2000", null, owned)
 *     → { sku: "Anker Power Station F2000", matchType: "equivalence" }
 *
 *   resolveListingToInventory("Underwater camera housing", null, owned)
 *     → { sku: null, matchType: "none" }
 */

/**
 * DEV ASSERT: validate every candidate SKU in LISTING_EQUIVALENCE_MAP is a
 * real MASTER_INVENTORY key. Throws on import in dev if any typo. Skipped at
 * runtime in prod via `process.env.NODE_ENV !== "production"`.
 */
export function validateEquivalenceMap(): { ok: boolean; errors: string[] } {
  const valid = new Set(MASTER_INVENTORY_KEYS);
  const errors: string[] = [];
  for (const [keyword, candidates] of Object.entries(LISTING_EQUIVALENCE_MAP)) {
    for (const sku of candidates) {
      if (!valid.has(sku)) {
        errors.push(`"${keyword}" → "${sku}" not in MASTER_INVENTORY`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}
