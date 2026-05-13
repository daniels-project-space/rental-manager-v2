/**
 * Wave 4 — ai_decision accessors.
 *
 * Owner of the `ai_decision` table. WRITE callers:
 *   - The Mastra `hygglo_poll` workflow's `writeDecisions` step
 *   - Wave 4.5 approval flow: Node orchestrator in
 *     `src/mastra/data/decisions.ts` calls `recordApproval` AFTER invoking
 *     the Hygglo write client (`src/lib/hygglo-write.ts`).
 * READ callers:
 *   - Dashboard admin UI (Wave 4.5 approval surface)
 *   - The dashboard-chat agent's `get_pending_decisions` /
 *     `approve_decision` tools (Wave 4.5).
 *
 * SAFETY: This module DOES NOT call Hygglo. Outbound Hygglo writes live
 * exclusively in `src/lib/hygglo-write.ts` (gated by READ_ONLY_MODE). The
 * Node orchestrator decides whether the action is approve / decline /
 * approve_modified and what audit fields to record.
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
 * NEVER calls Hygglo from here — that's the Wave 4.5 approval orchestrator
 * (`src/mastra/data/decisions.ts:applyApproval`).
 */
export const updateStatus = mutation({
  args: {
    id: v.id("ai_decision"),
    status: v.union(
      v.literal("approved"),
      v.literal("rejected"),
      v.literal("expired"),
      v.literal("approved_modified"),
      v.literal("declined"),
    ),
  },
  handler: async (ctx, { id, status }) => {
    const row = await ctx.db.get(id);
    if (!row) throw new Error("ai_decision row not found");
    await ctx.db.patch(id, { status });
    return { ok: true };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// Wave 4.5 — approval flow primitives.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Atomic recording of one approval action.
 *
 * Updates `ai_decision.status` + writes a paired `ai_decision_audit` row +
 * (when Hygglo accept actually fired) advances the parent
 * `reservations.status` from `pending_review` → `confirmed`. All in one
 * transaction so the audit can never disagree with the decision row.
 *
 * Caller is the Node orchestrator in `src/mastra/data/decisions.ts` which
 * has already invoked the Hygglo write client and knows the result.
 */
export const recordApproval = mutation({
  args: {
    decisionId: v.id("ai_decision"),
    action: v.union(
      v.literal("approve"),
      v.literal("decline"),
      v.literal("approve_modified"),
    ),
    actorSource: v.string(),
    finalReply: v.optional(v.string()),
    hygglo: v.object({
      attempted: v.boolean(),
      status: v.union(
        v.literal("sent"),
        v.literal("skipped"),
        v.literal("failed"),
      ),
      error: v.optional(v.string()),
      httpStatus: v.optional(v.number()),
    }),
  },
  handler: async (ctx, args) => {
    const decision = await ctx.db.get(args.decisionId);
    if (!decision) throw new Error("ai_decision row not found");

    const newStatus =
      args.action === "decline"
        ? "declined"
        : args.action === "approve_modified"
          ? "approved_modified"
          : "approved";
    await ctx.db.patch(args.decisionId, { status: newStatus });

    await ctx.db.insert("ai_decision_audit", {
      decisionId: args.decisionId,
      action: args.action,
      actorSource: args.actorSource,
      actedAt: Date.now(),
      finalReply: args.finalReply,
      hygglo: args.hygglo,
    });

    let reservationAdvanced = false;
    if (args.action !== "decline" && args.hygglo.status === "sent") {
      const reservation = await ctx.db.get(decision.reservation_id);
      if (reservation && reservation.status === "pending_review") {
        await ctx.db.patch(decision.reservation_id, { status: "confirmed" });
        reservationAdvanced = true;
      }
    }

    return {
      ok: true,
      newStatus,
      reservationAdvanced,
      account_slug: decision.account_slug,
      reservation_id: decision.reservation_id,
      hygglo_order_id: decision.hygglo_order_id ?? null,
    };
  },
});

/**
 * Wave 4.5 — Node orchestrator helper. Fetches decision + parent reservation
 * in one round-trip BEFORE the orchestrator calls Hygglo.
 */
export const getForApproval = query({
  args: { decisionId: v.id("ai_decision") },
  handler: async (ctx, { decisionId }) => {
    const decision = await ctx.db.get(decisionId);
    if (!decision) return null;
    const reservation = await ctx.db.get(decision.reservation_id);
    return { decision, reservation };
  },
});

/**
 * Wave 4.5 — chat-UI surface. Pending decisions enriched with renter/item
 * snippets + a short stable id slug (last 6 chars of the Convex doc id) so
 * users can say "approve abc123" in chat.
 */
export const getPendingForUI = query({
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
      : ctx.db
          .query("ai_decision")
          .withIndex("by_status", (idx) => idx.eq("status", "pending"));
    const rows = await q.order("desc").take(limit ?? 20);

    return await Promise.all(
      rows.map(async (row) => {
        const reservation = await ctx.db.get(row.reservation_id);
        const renterName = reservation?.renter_name ?? null;
        const firstItem =
          (reservation?.items && reservation.items[0]?.item_name) ?? null;
        return {
          id: row._id,
          shortId: String(row._id).slice(-6),
          account_slug: row.account_slug,
          decision: row.decision,
          confidence: row.confidence,
          reasoning: row.reasoning,
          suggestedReply: row.suggestedReply,
          redFlags: row.redFlags,
          renterName,
          firstItem,
          startDate: reservation?.start_date ?? null,
          endDate: reservation?.end_date ?? null,
          totalGbp: reservation?.gross_paid_gbp ?? null,
          generatedAt: row.generatedAt,
        };
      }),
    );
  },
});

/**
 * Wave 4.5 — resolve a short id slug (last 6 chars of a doc id) to the
 * underlying `ai_decision` id. Scans only currently-pending rows so cost
 * is O(pending-count). Returns null on no-match or ambiguous match.
 */
export const resolveShortId = query({
  args: { shortId: v.string() },
  handler: async (ctx, { shortId }) => {
    const rows = await ctx.db
      .query("ai_decision")
      .withIndex("by_status", (idx) => idx.eq("status", "pending"))
      .collect();
    const matches = rows.filter((r) => String(r._id).endsWith(shortId));
    if (matches.length !== 1) return null;
    return matches[0]._id;
  },
});
