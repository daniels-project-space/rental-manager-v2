/**
 * Wave 4 — ai_decision accessors.
 *
 * Owner of the `ai_decision` table. WRITE callers:
 *   - The Mastra `hygglo_poll` workflow's `writeDecisions` step
 * READ callers:
 *   - Dashboard admin UI (Wave 4.5 approval surface)
 *   - The dashboard-chat agent's `get_pending_decisions` tool (future)
 *
 * SAFETY: This module does NOT call Hygglo. Approval action is left for
 * a future wave so Daniel reviews each decision before any side effect.
 */
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const decisionEnum = v.union(
  v.literal("accept"),
  v.literal("decline"),
  v.literal("ask_renter"),
);

export const writeDecision = mutation({
  args: {
    reservation_id: v.id("reservations"),
    hygglo_order_id: v.optional(v.string()),
    account_slug: v.string(),
    decision: decisionEnum,
    confidence: v.number(),
    reasoning: v.string(),
    suggestedReply: v.string(),
    redFlags: v.array(v.string()),
    generatedByAgent: v.string(),
    modelId: v.optional(v.string()),
    pollingRunId: v.optional(v.id("polling_runs")),
  },
  handler: async (ctx, args) => {
    // Skip if a pending decision already exists for this reservation.
    const existing = await ctx.db
      .query("ai_decision")
      .withIndex("by_reservation", (q) =>
        q.eq("reservation_id", args.reservation_id),
      )
      .filter((q) => q.eq(q.field("status"), "pending"))
      .first();
    if (existing) return { inserted: false, id: existing._id, reason: "duplicate_pending" };

    const id = await ctx.db.insert("ai_decision", {
      ...args,
      status: "pending",
      generatedAt: Date.now(),
    });
    return { inserted: true, id };
  },
});

export const getPending = query({
  args: {
    account: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { account, limit }) => {
    const q = account
      ? ctx.db
          .query("ai_decision")
          .withIndex("by_account_status", (idx) =>
            idx.eq("account_slug", account).eq("status", "pending"),
          )
      : ctx.db.query("ai_decision").withIndex("by_status", (idx) => idx.eq("status", "pending"));
    return await q.order("desc").take(limit ?? 20);
  },
});

export const getForReservation = query({
  args: { reservation_id: v.id("reservations") },
  handler: async (ctx, { reservation_id }) => {
    return await ctx.db
      .query("ai_decision")
      .withIndex("by_reservation", (q) => q.eq("reservation_id", reservation_id))
      .order("desc")
      .collect();
  },
});

/**
 * Daniel-facing transition. Public mutation (auth-gated at API layer).
 * NEVER calls Hygglo from here — that's a separate Wave 4.5 approval action.
 */
export const updateStatus = mutation({
  args: {
    id: v.id("ai_decision"),
    status: v.union(
      v.literal("approved"),
      v.literal("rejected"),
      v.literal("expired"),
    ),
  },
  handler: async (ctx, { id, status }) => {
    const row = await ctx.db.get(id);
    if (!row) throw new Error("ai_decision row not found");
    await ctx.db.patch(id, { status });
    return { ok: true };
  },
});
