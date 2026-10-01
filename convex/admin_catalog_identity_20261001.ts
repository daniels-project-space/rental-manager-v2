import { internalMutation } from "./_generated/server";
import { shortItemName } from "./lib/item_display_name";

/** Owner-authorized display assignment; IDs, quantities and prices stay stable. */
export const run = internalMutation({ args: {}, handler: async ctx => {
  const items = await ctx.db.query("items").collect();
  const changed = [];
  for (const item of items) {
    const macro = item.name_canonical === "Sony GM 90mm f2.8";
    const name = macro ? "Sony FE 90mm f2.8 Macro G OSS" : item.name_canonical;
    const display_name = macro ? "Sony 90mm f/2.8 Macro G OSS" : shortItemName(item);
    const aliases = [...new Set([...(item.aliases ?? []), item.name_canonical, display_name])].filter(n => n !== name);
    await ctx.db.patch(item._id, { name_canonical: name, display_name, aliases, updated_at: Date.now(), ...(macro ? { image_url: undefined } : {}) });
    if (macro) {
      const spec = await ctx.db.query("item_specs").withIndex("by_item", q => q.eq("item_id", item._id)).first();
      if (!spec) throw new Error("Missing macro model record; correction must remain atomic");
      await ctx.db.patch(spec._id, { item_name_canonical: name,
        description: "Sony FE 90mm F2.8 Macro G OSS (SEL90M28G): Sony G-series E-mount full-frame macro lens, not a G Master model. Up to 1:1 magnification, minimum focus distance 0.28m, Optical SteadyShot, 62mm filter diameter and 602g weight. Manufacturer box contents do not establish rental inclusions.",
        specs_long: "", source: "manufacturer-verified", source_url: "https://www.sony.co.uk/electronics/camera-lenses/sel90m28g", verified_model: "SEL90M28G", verified_at: Date.now() });
      const prices = await ctx.db.query("pricing_catalog").withIndex("by_name", q => q.eq("item_name_canonical", item.name_canonical)).collect();
      for (const p of prices) await ctx.db.patch(p._id, { item_name_canonical: name });
      changed.push({ item_id: item._id, before: item.name_canonical, after: name, previous_spec: spec.description, previous_image: item.image_url });
    }
  }
  return { assigned: items.length, changed };
} });
