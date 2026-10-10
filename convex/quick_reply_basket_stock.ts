import { internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { checkOrderRentalStock } from "./lib/renter_order_stock";
/** Internal proposal qualification; only the owner action exposes verified plans. */
export const check = internalQuery({
  args: {
    account_slug: v.string(),
    thread_id: v.string(),
    start: v.string(),
    end: v.string(),
    lines: v.array(
      v.object({
        name: v.string(),
        qty: v.number(),
        product_id: v.optional(v.number()),
        item_id: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, a) =>
    checkOrderRentalStock(
      ctx,
      a.account_slug,
      a.lines,
      a.start,
      a.end,
      a.thread_id,
    ),
});
