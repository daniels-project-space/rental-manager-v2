import { internalMutation } from "./_generated/server";
import { components } from "./_generated/api";
import { v } from "convex/values";

/** Privileged cleanup exclusively for this audit's deliberately named auth fixtures. */
export const cleanup = internalMutation({
  args: { auth_user_id: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "user", where: [{ field: "_id", value: args.auth_user_id }],
    });
    if (!user || !("email" in user) || !/^__probe__owner_auth_[a-f0-9]+@example\.invalid$/.test(String(user.email))) {
      throw new Error("Refusing to remove an authentication account outside this audit's fixtures.");
    }
    const owner = await ctx.db.query("owner_access").first();
    if (owner?.auth_user_id === args.auth_user_id) await ctx.db.delete(owner._id);
    for (const model of ["session", "account"] as const) {
      await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
        input: { model, where: [{ field: "userId", value: args.auth_user_id }] },
        paginationOpts: { numItems: 100, cursor: null },
      });
    }
    await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
      input: { model: "user", where: [{ field: "_id", value: args.auth_user_id }] },
      paginationOpts: { numItems: 100, cursor: null },
    });
    const remainingUser = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "user", where: [{ field: "_id", value: args.auth_user_id }],
    });
    const remainingSession = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "session", where: [{ field: "userId", value: args.auth_user_id }],
    });
    const remainingAccount = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "account", where: [{ field: "userId", value: args.auth_user_id }],
    });
    if (remainingUser || remainingSession || remainingAccount) throw new Error("Authentication fixture cleanup is incomplete.");
    return { cleaned: true, user_absent: true, sessions_absent: true, accounts_absent: true };
  },
});
