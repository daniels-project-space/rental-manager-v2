import { internalMutation } from "./_generated/server";
import { REVIEWED_REMUS_SPECS, REMUS_SPEC_SOURCE, reviewedRemusDescription } from "./lib/reviewed_remus_specs";

/** Inventory corrections only; never edits marketplace listings or bookings. */
export const run = internalMutation({
  args: {},
  handler: async ctx => {
    const changed = [];
    for (const facts of REVIEWED_REMUS_SPECS) {
      const item = await ctx.db.query("items").withIndex("by_canonical_name", q => q.eq("name_canonical", facts.name)).unique();
      if (!item || item.kind !== "lens" || item.status !== "active" || item.is_marketing_only || item.qty < 1 || !/\bPL\b/.test(item.lens_mount ?? "")) throw new Error(`Exact owned PL lens identity requires review: ${facts.name}`);
      const previous = await ctx.db.query("item_specs").withIndex("by_item", q => q.eq("item_id", item._id)).unique();
      const patch = {item_id: item._id, item_name_canonical: item.name_canonical, description: reviewedRemusDescription(facts), specs_long: "", source: "manufacturer-verified", source_url: REMUS_SPEC_SOURCE, verified_model: facts.model};
      if (previous?.source === patch.source && previous.source_url === patch.source_url && previous.verified_model === patch.verified_model && previous.description === patch.description && previous.specs_long === "") {changed.push({name: facts.name, changed: false}); continue;}
      if (previous) await ctx.db.patch(previous._id, {...patch, verified_at: Date.now()});
      else await ctx.db.insert("item_specs", {...patch, verified_at: Date.now(), created_at: Date.now()});
      changed.push({name: facts.name, changed: true, previous_description: previous?.description ?? null, previous_source: previous?.source ?? null, model: facts.model});
    }
    return {source: REMUS_SPEC_SOURCE, changed};
  },
});
