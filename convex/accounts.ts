import { query } from "./_generated/server";
import { v } from "convex/values";

// W01 account selector — list all accounts with their profiles
export const list = query({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("accounts").collect();
    return accounts;
  },
});

// W01, W02 — account + profile detail for a single slug
export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const account = await ctx.db
      .query("accounts")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (!account) return null;
    const profile = await ctx.db
      .query("account_profiles")
      .withIndex("by_account", (q) => q.eq("account_id", account._id))
      .first();
    return { account, profile };
  },
});
