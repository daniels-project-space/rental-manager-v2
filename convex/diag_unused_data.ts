import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * Data we HOLD but the renter bot never reads.
 *
 * A field the bot cannot see is a question it cannot answer — and renters ask
 * these constantly ("what card does it take?", "does it come with batteries?",
 * "what if I have to cancel?", "can you deliver?"). This counts how many
 * rentable items actually carry each field, so effort goes to the ones with
 * real data rather than to empty columns.
 *
 * Read-only.
 */
export const check = internalQuery({
  args: {},
  handler: async (ctx) => {
    const items = (await ctx.db.query("items").collect()).filter(
      (i) => i.status === "active" && !i.is_marketing_only && (i.qty ?? 0) > 0,
    );
    const n = items.length;
    const count = (f: (i: (typeof items)[number]) => boolean) => items.filter(f).length;

    const comp = (i: (typeof items)[number]) =>
      i.compatibility as
        | {
            batteries?: string[];
            cards?: string[];
            lenses?: string[];
            accessories?: string[];
            included_with_rental?: string[];
          }
        | undefined;

    const [specs, canned, reviews, photos] = await Promise.all([
      ctx.db.query("item_specs").collect(),
      ctx.db.query("canned_responses").collect(),
      ctx.db.query("renter_reviews").collect(),
      ctx.db.query("listing_photos").collect(),
    ]);

    return {
      rentable_items: n,
      fields: {
        cancellation_policy: count((i) => !!i.cancellation_policy),
        delivery_notes: count((i) => !!i.delivery_notes),
        battery_type: count((i) => !!i.battery_type),
        card_type: count((i) => !!i.card_type),
        replacement_cost_gbp: count((i) => i.replacement_cost_gbp != null),
        weight_kg: count((i) => i.weight_kg != null),
        dimensions: count((i) => i.length_cm != null && i.width_cm != null),
        notes: count((i) => !!i.notes),
      },
      compatibility: {
        any: count((i) => !!comp(i)),
        batteries: count((i) => (comp(i)?.batteries?.length ?? 0) > 0),
        cards: count((i) => (comp(i)?.cards?.length ?? 0) > 0),
        lenses: count((i) => (comp(i)?.lenses?.length ?? 0) > 0),
        accessories: count((i) => (comp(i)?.accessories?.length ?? 0) > 0),
        included_with_rental: count(
          (i) => (comp(i)?.included_with_rental?.length ?? 0) > 0,
        ),
      },
      tables: {
        item_specs: specs.length,
        canned_responses: canned.length,
        renter_reviews: reviews.length,
        listing_photos: photos.length,
      },
      // A concrete look at the richest rows, to judge whether the content is
      // actually useful to a renter or just internal shorthand.
      samples: items
        .filter((i) => (comp(i)?.included_with_rental?.length ?? 0) > 0 || !!i.card_type)
        .slice(0, 6)
        .map((i) => ({
          name: i.name_canonical,
          battery_type: i.battery_type ?? null,
          card_type: i.card_type ?? null,
          included: comp(i)?.included_with_rental ?? null,
          cards: comp(i)?.cards ?? null,
          batteries: comp(i)?.batteries ?? null,
        })),
    };
  },
});

export default internalAction({
  handler: async (ctx): Promise<unknown> =>
    ctx.runQuery(internal.diag_unused_data.check, {}),
});
