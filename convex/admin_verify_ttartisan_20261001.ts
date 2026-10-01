import { internalMutation } from "./_generated/server";

/** Owner confirmed model/mount; manufacturer facts replace the mixed Sony spec. */
export const run = internalMutation({ args: {}, handler: async ctx => {
  const oldName = "Sony 11mm f2.8 fisheye";
  const name = "TTArtisan 11mm f2.8 Fisheye (Sony E)";
  const items = await ctx.db.query("items").collect();
  const item = items.find(i => String(i._id) === "kn76chbtwhyv1987y4ae3pj2dh86bw7d");
  if (!item || item.kind !== "lens" || ![oldName, name].includes(item.name_canonical)) throw new Error("Reviewed lens identity changed");
  const spec = await ctx.db.query("item_specs").withIndex("by_item", q => q.eq("item_id", item._id)).unique();
  if (!spec) throw new Error("Missing reviewed lens spec");
  const display_name = "TTArtisan 11mm f/2.8 fisheye (E)";
  await ctx.db.patch(item._id, { name_canonical: name, display_name,
    lens_mount: "Sony E-mount (full frame)",
    aliases: [...new Set([...(item.aliases ?? []), oldName, item.name_input, display_name])].filter(n => n !== name), updated_at: Date.now() });
  await ctx.db.patch(spec._id, { item_name_canonical: name,
    description: "TTArtisan 11mm F2.8 Fisheye, Sony E-mount copy confirmed by the owner. Full-frame manual-focus fisheye lens; not a Sony-brand lens and not the Sony SEL11F18. Maximum aperture f/2.8, 180-degree diagonal field of view and 0.17m closest focusing distance. No autofocus. Manufacturer product information does not establish rental kit inclusions.",
    specs_long: "", source: "manufacturer-verified",
    source_url: "https://www.ttartisan.co.za/product/ttartisan-11mm-f2-8-manual-focus-lens-fisheye-lens-full-frame-black/",
    verified_model: "TTArtisan 11mm F2.8 Fisheye (Sony E)", verified_at: Date.now() });
  const prices = await ctx.db.query("pricing_catalog").withIndex("by_name", q => q.eq("item_name_canonical", oldName)).collect();
  for (const p of prices) await ctx.db.patch(p._id, { item_name_canonical: name });
  const compatibilityChanges = [];
  for (const camera of items) {
    if (!camera.compatibility?.lenses?.includes(oldName)) continue;
    await ctx.db.patch(camera._id, { compatibility: { ...camera.compatibility, lenses: camera.compatibility.lenses.map(n => n === oldName ? name : n) }, updated_at: Date.now() });
    compatibilityChanges.push(camera.name_canonical);
  }
  return { item_id: item._id, before: { name: item.name_canonical, mount: item.lens_mount, spec }, after: { name, display_name }, priceReferences: prices.length, compatibilityChanges };
} });
