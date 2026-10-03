import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

export const get = internalQuery({
  args: {},
  handler: async (ctx) => ctx.db.query("owner_access").first(),
});

/** Atomic singleton binding: two simultaneous signups cannot claim two owners. */
export const register = internalMutation({
  args: { auth_user_id: v.string(), email: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("owner_access").first();
    if (existing) {
      if (existing.auth_user_id === args.auth_user_id) return existing._id;
      throw new Error("Owner setup has already been completed.");
    }
    return ctx.db.insert("owner_access", {
      auth_user_id: args.auth_user_id,
      email: args.email.trim().toLowerCase(),
      created_at: Date.now(),
    });
  },
});
