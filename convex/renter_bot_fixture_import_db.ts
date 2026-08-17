/**
 * renter_bot_fixture_import_db — the DB-write half of the fixture importer,
 * split into its own (non-"use node") file. Convex requires mutations to run
 * in the default runtime, not the Node.js runtime the Hygglo fetch client in
 * renter_bot_fixture_import.ts needs — a mutation can't live in a "use node"
 * file. Called only from renter_bot_fixture_import.ts's importFromHygglo.
 */
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

export const insertFixture = internalMutation({
  args: {
    name: v.string(),
    account_slug: v.string(),
    scenario_type: v.string(),
    source: v.union(
      v.literal("v1_scenario_port"),
      v.literal("hygglo_import"),
      v.literal("manual"),
    ),
    hygglo_order_id: v.optional(v.string()),
    seed_context: v.optional(
      v.object({
        location: v.optional(v.string()),
        items: v.optional(v.array(v.string())),
        price_gbp: v.optional(v.number()),
      }),
    ),
    messages: v.array(
      v.object({
        role: v.union(v.literal("renter"), v.literal("owner")),
        text: v.string(),
        at: v.number(),
      }),
    ),
    description: v.optional(v.string()),
    active: v.boolean(),
    created_at: v.number(),
    created_by: v.string(),
  },
  handler: async (ctx, args) => {
    // Re-importing the same order updates the existing fixture instead of
    // piling up duplicates.
    if (args.hygglo_order_id) {
      const existing = await ctx.db
        .query("renter_bot_fixtures")
        .withIndex("by_hygglo_order_id", (q) =>
          q.eq("hygglo_order_id", args.hygglo_order_id),
        )
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, args);
        return existing._id;
      }
    }
    return await ctx.db.insert("renter_bot_fixtures", args);
  },
});
