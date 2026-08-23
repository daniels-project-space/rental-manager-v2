import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

/** Full unread detail for a few items, to judge whether the content is renter-usable. */
export const show = internalQuery({
  args: { kind: v.optional(v.string()) },
  handler: async (ctx, { kind }) => {
    const items = (await ctx.db.query("items").collect()).filter(
      (i) =>
        i.status === "active" &&
        !i.is_marketing_only &&
        (i.qty ?? 0) > 0 &&
        (!kind || i.kind === kind),
    );
    const specs = await ctx.db.query("item_specs").collect();
    const specByItem = new Map(specs.map((s) => [String(s.item_id), s]));
    return items.slice(0, 5).map((i) => {
      const c = i.compatibility as
        | {
            batteries?: string[];
            cards?: string[];
            accessories?: string[];
            included_with_rental?: string[];
          }
        | undefined;
      const sp = specByItem.get(String(i._id));
      return {
        name: i.name_canonical,
        battery_type: i.battery_type ?? null,
        card_type: i.card_type ?? null,
        replacement_cost_gbp: i.replacement_cost_gbp ?? null,
        weight_kg: i.weight_kg ?? null,
        dims: i.length_cm ? `${i.length_cm}x${i.width_cm}x${i.height_cm}cm` : null,
        delivery_notes: (i.delivery_notes ?? "").slice(0, 90) || null,
        included_with_rental: c?.included_with_rental ?? null,
        accessories: c?.accessories ?? null,
        spec: sp ? (sp.description ?? "").slice(0, 120) : null,
      };
    });
  },
});

export default internalAction({
  args: { kind: v.optional(v.string()) },
  handler: async (ctx, a): Promise<unknown> =>
    ctx.runQuery(internal.diag_item_detail.show, a),
});
