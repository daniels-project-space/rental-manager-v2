import { mutation, query } from "./_generated/server";
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

/** List recent denial records */
export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const take = limit ?? 10;
    const rows = await ctx.db.query("denial_records").order("desc").take(take);
    return rows.map((r) => ({
      id: r._id,
      accountId: r.account_id,
      itemName: r.item_name,
      reason: r.reason,
      estimatedValue: r.estimated_value,
      notes: r.notes,
      createdAt: r.created_at,
    }));
  },
});

/** Update a denial record */
export const update = mutation({
  args: {
    id: v.id("denial_records"),
    itemName: v.optional(v.string()),
    reason: v.optional(v.string()),
    estimatedValue: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, { id, ...fields }) => {
    const patch: Record<string, unknown> = {};
    if (fields.itemName !== undefined) patch.item_name = fields.itemName;
    if (fields.reason !== undefined) patch.reason = fields.reason;
    if (fields.estimatedValue !== undefined) patch.estimated_value = fields.estimatedValue;
    if (fields.notes !== undefined) patch.notes = fields.notes;
    await ctx.db.patch(id, patch);
    return { ok: true };
  },
});

/** Delete a denial record */
export const remove = mutation({
  args: { id: v.id("denial_records") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete(id);
    return { ok: true };
  },
});
