import { mutation } from "./_generated/server";
import { v } from "convex/values";

/** W16 Denial Recording - insert a denial record from the dashboard UI. */
export const createDenial = mutation({
  args: {
    itemName: v.string(),
    reason: v.string(),
    estimatedValue: v.optional(v.number()),
    notes: v.optional(v.string()),
    accountSlug: v.optional(v.string()),
  },
  handler: async (ctx, { itemName, reason, estimatedValue, notes, accountSlug }) => {
    let accountId: import("./_generated/dataModel").Id<"accounts"> | undefined;
    if (accountSlug) {
      const acc = await ctx.db
        .query("accounts")
        .withIndex("by_slug", (q) => q.eq("slug", accountSlug))
        .first();
      accountId = acc?._id;
    }
    const id = await ctx.db.insert("denial_records", {
      account_id: accountId,
      reason,
      item_name: itemName,
      estimated_value: estimatedValue,
      notes,
      created_at: Date.now(),
    });
    return { ok: true, id };
  },
});
