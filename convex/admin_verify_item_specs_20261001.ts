import { internalMutation } from "./_generated/server";
/** Reviewed against Sony's exact ILCE-7M5 page on 2026-10-01; no kit ownership inference. */
export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    const item = await ctx.db.query("items").withIndex("by_canonical_name", q => q.eq("name_canonical", "Sony A7 V")).first();
    if (!item) throw new Error("Sony A7 V inventory identity is missing");
    const spec = await ctx.db.query("item_specs").withIndex("by_item", q => q.eq("item_id", item._id)).first();
    const facts = { item_id: item._id, item_name_canonical: item.name_canonical,
      description: "Sony Alpha 7 V (ILCE-7M5). Approximately 33MP effective still-image resolution; full-frame Exmor RS CMOS sensor. Sony E mount. Slot 1 accepts SD UHS-I/II or CFexpress Type A; slot 2 accepts SD UHS-I/II. Internal UHD 4K up to 60p in full-frame mode. At 60p/50p, use 4K angle of view Priority On for full-width recording. UHD 4K120p/100p requires APS-C/Super 35 capture and a reduced angle of view; it is not full-frame or uncropped 4K120.",
      specs_long: "Recording-area restrictions verified in Sony ILCE-7M5 Help Guide: https://helpguide.sony.net/ilc/2540/v1/en/contents/0404M_angle_of_view.html", source: "manufacturer-verified", verified_model: "ILCE-7M5",
      source_url: "https://www.sony.co.uk/electronics/support/e-mount-body-ilce-7-series/ilce-7m5/specifications", verified_at: Date.now() };
    if (spec) await ctx.db.patch(spec._id, facts); else await ctx.db.insert("item_specs", { ...facts, created_at: Date.now() });
    await ctx.db.patch(item._id, { card_type: "Slot 1: SD UHS-I/II or CFexpress Type A; slot 2: SD UHS-I/II" });
    return { item: item.name_canonical, previous_source: spec?.source ?? null, previous_description: spec?.description ?? null, source: facts.source_url, model: facts.verified_model };
  },
});
