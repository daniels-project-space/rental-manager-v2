import { internalMutation } from "./_generated/server";
import { REVIEWED_CAMERA_SPECS } from "./lib/reviewed_camera_specs";
export const run = internalMutation({
 args: {}, handler: async ctx => {
  const changed = [];
  for (const facts of REVIEWED_CAMERA_SPECS) {
   const item = await ctx.db.query("items").withIndex("by_canonical_name", q => q.eq("name_canonical", facts.name)).first();
   if (!item || item.kind !== "camera") throw new Error(`Missing exact camera identity: ${facts.name}`);
   const previous = await ctx.db.query("item_specs").withIndex("by_item", q => q.eq("item_id", item._id)).first();
   const patch = { item_id: item._id, item_name_canonical: item.name_canonical, description: facts.description, specs_long: "", source: "manufacturer-verified", source_url: facts.url, verified_model: facts.model, verified_at: Date.now() };
   if (previous) await ctx.db.patch(previous._id, patch); else await ctx.db.insert("item_specs", { ...patch, created_at: Date.now() });
   if ("battery_type" in facts) {
    const fullFrame = facts.name === "BMPCC 6K Full Frame";
    const included = (item.compatibility?.included_with_rental ?? []).map(s => s.replace(/(?:Canon\s+)?LP-E6NH/gi, "NP-F570"));
    if (fullFrame) {
     // Owner confirmed actual supplied storage, not merely camera compatibility.
     const withoutOldCards = included.filter(s => !/\bcard\b/i.test(s));
     included.splice(0, included.length, ...withoutOldCards, "1x 1TB CFexpress Type B card");
    }
    await ctx.db.patch(item._id, { battery_type: facts.battery_type, card_type: facts.card_type,
     compatibility: { ...item.compatibility, batteries: ["NP-F570"], ...(fullFrame ? { cards: ["1TB CFexpress Type B card"] } : {}), included_with_rental: included }, updated_at: Date.now() });
    const allItems = await ctx.db.query("items").collect();
    const overrides = await ctx.db.query("listing_resolution_override").collect();
    for (const row of overrides.filter(r => r.components.some(c => c.item_id === item._id))) {
     // Do not alter another camera's accessories in a mixed-body listing.
     if (row.components.some(c => c.item_id !== item._id && allItems.find(i => i._id === c.item_id)?.kind === "camera")) continue;
     const components = row.components.filter(c => {
      const name = allItems.find(i => i._id === c.item_id)?.name_canonical ?? "";
      return !/LP-E6/i.test(name) && !(fullFrame && name === "256GB card");
     });
     if (components.length !== row.components.length) await ctx.db.patch(row._id, { components, updated_at: Date.now(), note: `${row.note ?? ""} Owner confirmed NP-F570 batteries${fullFrame ? " and included 1TB CFexpress Type B card" : ""} on 2026-10-01; removed conflicting accessory mappings.` });
    }
   }
   changed.push({ name: facts.name, model: facts.model, source: facts.url, previous_description: previous?.description ?? null, previous_source: previous?.source ?? null, previous_kit: item.compatibility ?? null });
  }
  return { changed };
 }
});
