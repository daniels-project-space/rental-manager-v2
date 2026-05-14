/**
 * One-shot seed of v1's hard-coded bundle definitions into the v2 `bundles`
 * + `bundle_items` tables. Run once via:
 *   npx convex run bundles_seed:seedFromV1 '{}'
 *
 * Idempotent: replaces existing rows keyed by slug.
 *
 * v2 keeps item linking via item_name_canonical → items.name_canonical exact
 * match (verified — all 14 v1 bundle items have an exact name match in v2
 * inventory at seed time).
 */

import { mutation } from "./_generated/server";

interface V1Bundle {
  slug: string;
  bundle_name: string;
  description: string;
  items: string[];                  // duplicate names allowed → qty
  category: string;
  daily_price_min: number;
  daily_price_max?: number;
  account_scope: "both" | "leo" | "dbcinema";
  is_fake?: boolean;
}

const V1_BUNDLES: V1Bundle[] = [
  // Cinema Camera Kits
  {
    slug: "sony-fx3-24-70-gm-kit",
    bundle_name: "Sony FX3 + 24-70mm GM Kit",
    description: "FX3 body + Sony GM 24-70mm f2.8 lens",
    items: ["Sony FX3", "Sony GM 24-70mm f2.8"],
    category: "camera_kit",
    daily_price_min: 55,
    account_scope: "both",
  },
  {
    slug: "sony-fx3-full-production-kit",
    bundle_name: "Sony FX3 Full Production Kit",
    description: "FX3 + 24-70mm GM + RS3 gimbal + Rode wireless mic + Atomos Ninja V + ND filter",
    items: [
      "Sony FX3", "Sony GM 24-70mm f2.8", "DJI RS3 Pro gimbal",
      "Rode Wireless Mic Pro set", "Atomos Ninja V", "ND filter",
    ],
    category: "camera_kit",
    daily_price_min: 120,
    account_scope: "both",
  },
  {
    slug: "sony-fx3-full-production-kit-vmount-95",
    bundle_name: "Sony FX3 Full Production Kit + V-Mount 95mAh",
    description: "Full Production Kit with V-mount 95mAh battery",
    items: [
      "Sony FX3", "Sony GM 24-70mm f2.8", "DJI RS3 Pro gimbal",
      "Rode Wireless Mic Pro set", "Atomos Ninja V", "ND filter",
      "V-mount 95mAh",
    ],
    category: "camera_kit",
    daily_price_min: 130,
    account_scope: "both",
  },
  {
    slug: "sony-fx3-full-production-kit-vmount-150",
    bundle_name: "Sony FX3 Full Production Kit + V-Mount 150mAh",
    description: "Full Production Kit with V-mount 150mAh battery",
    items: [
      "Sony FX3", "Sony GM 24-70mm f2.8", "DJI RS3 Pro gimbal",
      "Rode Wireless Mic Pro set", "Atomos Ninja V", "ND filter",
      "V-mount 150mAh",
    ],
    category: "camera_kit",
    daily_price_min: 140,
    account_scope: "both",
  },
  {
    slug: "bmpcc-6k-pro-cinema-kit",
    bundle_name: "BMPCC 6K Pro Cinema Kit",
    description: "BMPCC 6K Pro + Canon EF 24-105mm + RS3 gimbal + Atomos Ninja V",
    items: [
      "BMPCC 6K Pro", "Canon EF 24-105mm f4", "DJI RS3 Pro gimbal", "Atomos Ninja V",
    ],
    category: "camera_kit",
    daily_price_min: 120,
    account_scope: "both",
  },
  // Lens Sets
  {
    slug: "sony-gm-triple-lens-set",
    bundle_name: "Sony GM Triple Lens Set",
    description: "16-35mm + 24-70mm + 70-200mm GM lenses",
    items: ["Sony GM 16-35mm f2.8", "Sony GM 24-70mm f2.8", "Sony GM 70-200mm f2.8"],
    category: "lens_set",
    daily_price_min: 55,
    account_scope: "both",
  },
  {
    slug: "blazar-remus-4-lens-anamorphic-set",
    bundle_name: "Blazar Remus 4-Lens Anamorphic Set",
    description: "33 + 45 + 65 + 100mm Blazar Remus anamorphic lenses",
    items: [
      "Anamorphic Blazar Remus 33mm", "Anamorphic Blazar Remus 45mm",
      "Anamorphic Blazar Remus 65mm", "Anamorphic Blazar Remus 100mm",
    ],
    category: "lens_set",
    daily_price_min: 120,
    account_scope: "both",
  },
  // Lighting Packages
  {
    slug: "interview-lighting-kit",
    bundle_name: "Interview Lighting Kit",
    description: "2x LED panels + softbox",
    items: ["LED light panels RGB", "LED light panels RGB", "Softbox 85cm"],
    category: "lighting",
    daily_price_min: 40,
    account_scope: "both",
  },
  {
    slug: "full-lighting-kit",
    bundle_name: "Full Lighting Kit",
    description: "Nanlite Forza 300 + 2x Pavotube 30x II + C-stand",
    items: [
      "Nanlite Forza 300", "Nanlite Pavotube 30x II", "Nanlite Pavotube 30x II", "C-stand",
    ],
    category: "lighting",
    daily_price_min: 70,
    account_scope: "both",
  },
  // Gimbal + Camera Combo
  {
    slug: "sony-fx3-rs3-gimbal-kit",
    bundle_name: "Sony FX3 + RS3 Pro Gimbal Kit",
    description: "Sony FX3 + DJI RS3 Pro gimbal",
    items: ["Sony FX3", "DJI RS3 Pro gimbal"],
    category: "camera_kit",
    daily_price_min: 58,
    account_scope: "both",
  },
];

export const seedFromV1 = mutation({
  args: {},
  handler: async (ctx) => {
    // Build canonical-name → item_id lookup once.
    const allItems = await ctx.db.query("items").collect();
    const idByName = new Map<string, string>();
    for (const it of allItems) idByName.set(it.name_canonical, it._id as string);

    const now = Date.now();
    let bundlesUpserted = 0;
    let itemsInserted = 0;
    const unresolvedNames = new Set<string>();

    for (const b of V1_BUNDLES) {
      const existing = await ctx.db
        .query("bundles")
        .withIndex("by_slug", (q) => q.eq("slug", b.slug))
        .first();
      let bundleId: import("./_generated/dataModel").Id<"bundles">;
      const bundlePatch = {
        slug: b.slug,
        bundle_name: b.bundle_name,
        daily_price_min: b.daily_price_min,
        daily_price_max: b.daily_price_max,
        account_scope: b.account_scope,
        savings_note: undefined,
        delivery_note: undefined,
        use_cases: undefined,
        trigger_keywords: undefined,
      };
      if (existing) {
        await ctx.db.patch(existing._id, bundlePatch);
        bundleId = existing._id;
        // Clear old items
        const oldItems = await ctx.db
          .query("bundle_items")
          .withIndex("by_bundle", (q) => q.eq("bundle_id", existing._id))
          .collect();
        for (const oi of oldItems) await ctx.db.delete(oi._id);
      } else {
        bundleId = await ctx.db.insert("bundles", { ...bundlePatch, created_at: now });
      }
      bundlesUpserted++;

      // Aggregate items by canonical name → qty
      const qtyByName = new Map<string, number>();
      for (const itemName of b.items) {
        qtyByName.set(itemName, (qtyByName.get(itemName) ?? 0) + 1);
      }
      for (const [itemName, qty] of qtyByName) {
        const itemId = idByName.get(itemName) as
          | import("./_generated/dataModel").Id<"items">
          | undefined;
        if (!itemId) unresolvedNames.add(itemName);
        await ctx.db.insert("bundle_items", {
          bundle_id: bundleId,
          item_id: itemId,
          item_name_canonical: itemName,
          qty,
        });
        itemsInserted++;
      }
    }

    return {
      bundles_upserted: bundlesUpserted,
      bundle_items_inserted: itemsInserted,
      unresolved_canonical_names: Array.from(unresolvedNames),
    };
  },
});
