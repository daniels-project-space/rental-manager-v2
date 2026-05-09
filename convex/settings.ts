import { query } from "./_generated/server";
import { v } from "convex/values";

// W01, W02, W20 — settings singleton row
export const get = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("settings").first();
  },
});
