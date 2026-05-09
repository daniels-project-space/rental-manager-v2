import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// W01, W02, W20 — settings singleton row
export const get = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("settings").first();
  },
});

/**
 * Update settings fields (partial).
 * SAFETY: throws if caller attempts to set both read_only_mode=false AND ALLOW_HYGGLO_SEND=true
 * in a single mutation — the double-unlock is unconditionally rejected.
 */
export const update = mutation({
  args: {
    read_only_mode: v.optional(v.boolean()),
    ALLOW_HYGGLO_SEND: v.optional(v.boolean()),
    polling_interval_ms: v.optional(v.number()),
    escalate_to_sonnet: v.optional(v.boolean()),
  },
  handler: async (ctx, fields) => {
    // Double-unlock guard: refuse read_only_mode=false + ALLOW_HYGGLO_SEND=true together
    if (fields.read_only_mode === false && fields.ALLOW_HYGGLO_SEND === true) {
      throw new Error(
        "SAFETY_RAIL: Cannot disable read_only_mode and enable ALLOW_HYGGLO_SEND in one mutation."
      );
    }
    const existing = await ctx.db.query("settings").first();
    if (!existing) throw new Error("No settings row found — seed the database first.");

    const patch: Record<string, unknown> = {};
    if (fields.read_only_mode !== undefined) patch.read_only_mode = fields.read_only_mode;
    if (fields.ALLOW_HYGGLO_SEND !== undefined) patch.ALLOW_HYGGLO_SEND = fields.ALLOW_HYGGLO_SEND;
    if (fields.polling_interval_ms !== undefined) patch.polling_interval_ms = fields.polling_interval_ms;
    if (fields.escalate_to_sonnet !== undefined) patch.escalate_to_sonnet = fields.escalate_to_sonnet;

    await ctx.db.patch(existing._id, patch);
    return { ok: true };
  },
});
