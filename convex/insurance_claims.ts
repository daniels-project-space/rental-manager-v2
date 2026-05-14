import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

/** W22 Insurance Claims — list recent claims, optional account filter */
export const list = query({
  args: { accountSlug: v.optional(v.string()) },
  handler: async (ctx, { accountSlug }) => {
    let rows = accountSlug
      ? await ctx.db
          .query("insurance_claims")
          .withIndex("by_account", (q) => q.eq("account_slug", accountSlug))
          .order("desc")
          .take(50)
      : await ctx.db
          .query("insurance_claims")
          .withIndex("by_claim_date")
          .order("desc")
          .take(50);
    return rows.map((r) => ({
      id: r._id,
      accountSlug: r.account_slug,
      itemNameCanonical: r.item_name_canonical,
      amountGbp: r.amount_gbp,
      claimDate: r.claim_date,
      description: r.description,
      status: r.status,
      createdAt: r.created_at,
    }));
  },
});

/** Create a new insurance claim */
export const create = mutation({
  args: {
    account_slug: v.optional(v.string()),
    item_id: v.optional(v.id("items")),
    item_name_canonical: v.optional(v.string()),
    amount_gbp: v.number(),
    claim_date: v.string(),
    description: v.optional(v.string()),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    let accountId: Id<"accounts"> | undefined;
    if (args.account_slug) {
      const acc = await ctx.db
        .query("accounts")
        .withIndex("by_slug", (q) => q.eq("slug", args.account_slug as string))
        .first();
      accountId = acc?._id;
    }
    const id = await ctx.db.insert("insurance_claims", {
      account_slug: args.account_slug,
      account_id: accountId,
      item_id: args.item_id,
      item_name_canonical: args.item_name_canonical,
      amount_gbp: args.amount_gbp,
      claim_date: args.claim_date,
      description: args.description,
      status: args.status,
      created_at: Date.now(),
    });
    return { ok: true, id };
  },
});

/** Update claim fields */
export const update = mutation({
  args: {
    id: v.id("insurance_claims"),
    amount_gbp: v.optional(v.number()),
    claim_date: v.optional(v.string()),
    description: v.optional(v.string()),
    status: v.optional(v.string()),
    item_name_canonical: v.optional(v.string()),
  },
  handler: async (ctx, { id, ...fields }) => {
    const patch: Record<string, unknown> = {};
    if (fields.amount_gbp !== undefined) patch.amount_gbp = fields.amount_gbp;
    if (fields.claim_date !== undefined) patch.claim_date = fields.claim_date;
    if (fields.description !== undefined) patch.description = fields.description;
    if (fields.status !== undefined) patch.status = fields.status;
    if (fields.item_name_canonical !== undefined) patch.item_name_canonical = fields.item_name_canonical;
    await ctx.db.patch(id, patch);
    return { ok: true };
  },
});

/** Delete a claim */
export const remove = mutation({
  args: { id: v.id("insurance_claims") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete(id);
    return { ok: true };
  },
});
