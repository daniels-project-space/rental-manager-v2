/**
 * Renter-bot draft persistence.
 *
 * READ-ONLY POSTURE (Phase 1-3): this module's ONLY writes are to the
 * `renter_bot_drafts` table. It NEVER:
 *   - calls Hygglo write APIs
 *   - writes to `hygglo_messages` table
 *   - flips `settings.ALLOW_HYGGLO_SEND`
 *   - schedules `hygglo-ui-action` for the renter side
 *
 * Operator UI (Telegram, Phase 1) mutates these rows when Daniel marks a
 * draft `sent` / `dismissed` after manually copy-pasting into Hygglo.
 */
import { mutation, query, internalMutation } from "./_generated/server";
import { v } from "convex/values";

// ── Mutations ─────────────────────────────────────────────────

/**
 * Insert a fresh draft. Idempotent on (thread_id, last_inbound_message_id):
 * if a pending draft already exists for the same trigger, this mutation
 * does NOT insert a duplicate — returns { action: "skipped", id }.
 *
 * When a NEWER inbound supersedes a pending draft, the workflow should
 * call `expireOldDrafts` separately before this.
 */
export const writeDraft = internalMutation({
  args: {
    thread_id: v.string(),
    account_slug: v.string(),
    last_inbound_message_id: v.string(),
    last_inbound_at: v.number(),
    draft_text: v.string(),
    original_draft: v.optional(v.string()),
    draft_intent: v.string(),
    draft_stage: v.optional(v.string()),
    draft_confidence: v.number(),
    draft_red_flags: v.array(v.string()),
    facts_claimed: v.optional(v.array(v.object({
      kind: v.string(),
      value: v.string(),
      sourceTool: v.string(),
      sourceCallId: v.string(),
      verified: v.boolean(),
    }))),
    needs_human: v.boolean(),
    needs_human_reason: v.optional(v.string()),
    generated_by: v.string(),
    model_id: v.string(),
    cost_usd: v.optional(v.number()),
    regeneration_count: v.optional(v.number()),
    escalated: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{
    action: "inserted" | "skipped";
    id: string;
  }> => {
    const existing = await ctx.db
      .query("renter_bot_drafts")
      .withIndex("by_last_inbound", (q) =>
        q.eq("last_inbound_message_id", args.last_inbound_message_id),
      )
      .filter((q) => q.eq(q.field("thread_id"), args.thread_id))
      .first();

    const status = args.escalated
      ? ("escalated" as const)
      : ("pending" as const);

    if (existing && existing.status === "pending") {
      return { action: "skipped", id: existing._id };
    }

    const id = await ctx.db.insert("renter_bot_drafts", {
      thread_id: args.thread_id,
      account_slug: args.account_slug,
      last_inbound_message_id: args.last_inbound_message_id,
      last_inbound_at: args.last_inbound_at,
      draft_text: args.draft_text,
      original_draft: args.original_draft ?? args.draft_text,
      draft_intent: args.draft_intent,
      draft_stage: args.draft_stage,
      draft_confidence: args.draft_confidence,
      draft_red_flags: args.draft_red_flags,
      facts_claimed: args.facts_claimed,
      needs_human: args.needs_human,
      needs_human_reason: args.needs_human_reason,
      status,
      generated_by: args.generated_by,
      model_id: args.model_id,
      generated_at: Date.now(),
      cost_usd: args.cost_usd,
      regeneration_count: args.regeneration_count ?? 0,
    });

    return { action: "inserted", id };
  },
});

/**
 * Expire any pending drafts whose `last_inbound_message_id` is older than
 * the latest message in the thread. Returns the count expired.
 *
 * Called by the workflow at enrich-time: as soon as we see a new inbound,
 * any pending draft for the OLD trigger goes stale.
 */
export const expireOldDrafts = internalMutation({
  args: {
    thread_id: v.string(),
    keep_last_inbound_message_id: v.string(),
  },
  handler: async (ctx, { thread_id, keep_last_inbound_message_id }): Promise<{
    expired: number;
  }> => {
    const rows = await ctx.db
      .query("renter_bot_drafts")
      .withIndex("by_thread_status", (q) =>
        q.eq("thread_id", thread_id).eq("status", "pending"),
      )
      .collect();
    let expired = 0;
    for (const r of rows) {
      if (r.last_inbound_message_id === keep_last_inbound_message_id) continue;
      await ctx.db.patch(r._id, { status: "expired" });
      expired += 1;
    }
    return { expired };
  },
});

/**
 * Operator marks a draft as `sent` after manually sending via Hygglo.
 * Records `final_sent_text` (may differ from draft_text — Daniel may
 * have edited before sending). Edit-detection = strict string equality
 * against `original_draft`.
 *
 * Telegram chat callbacks invoke this. Dashboard / direct call also fine.
 */
export const markSent = mutation({
  args: {
    id: v.id("renter_bot_drafts"),
    final_sent_text: v.string(),
    telegram_chat_id: v.optional(v.string()),
    telegram_message_id: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ ok: true; edited: boolean }> => {
    const row = await ctx.db.get(args.id);
    if (!row) throw new Error(`renter_bot_drafts ${args.id} not found`);
    const baseline = row.original_draft ?? row.draft_text;
    const edited = args.final_sent_text !== baseline;
    const now = Date.now();
    await ctx.db.patch(args.id, {
      status: "sent",
      final_sent_text: args.final_sent_text,
      telegram_chat_id: args.telegram_chat_id,
      telegram_message_id: args.telegram_message_id,
      telegram_sent_at: now,
    });
    await ctx.db.insert("audit_log", {
      table_name: "renter_bot_drafts",
      actor: "telegram_operator",
      op: "update",
      note: `marked sent (edited=${edited})`,
      source_file: "convex/renter_bot_drafts.ts:markSent",
      ts: now,
    });
    return { ok: true, edited };
  },
});

export const markDismissed = mutation({
  args: { id: v.id("renter_bot_drafts"), reason: v.optional(v.string()) },
  handler: async (ctx, { id, reason }): Promise<{ ok: true }> => {
    await ctx.db.patch(id, { status: "dismissed" });
    await ctx.db.insert("audit_log", {
      table_name: "renter_bot_drafts",
      actor: "telegram_operator",
      op: "update",
      note: reason ?? "dismissed",
      source_file: "convex/renter_bot_drafts.ts:markDismissed",
      ts: Date.now(),
    });
    return { ok: true };
  },
});

/**
 * Record the Telegram message id when the bot posts a fresh draft card
 * to Telegram. Lets the callback handler look up which draft a button
 * tap belongs to.
 */
export const recordTelegramPost = internalMutation({
  args: {
    id: v.id("renter_bot_drafts"),
    telegram_chat_id: v.string(),
    telegram_message_id: v.string(),
  },
  handler: async (ctx, { id, telegram_chat_id, telegram_message_id }) => {
    await ctx.db.patch(id, { telegram_chat_id, telegram_message_id });
  },
});

// ── Queries ────────────────────────────────────────────────────

export const listPending = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db
      .query("renter_bot_drafts")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .order("desc")
      .take(limit ?? 50);
    return rows;
  },
});

export const listByThread = query({
  args: { thread_id: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { thread_id, limit }) => {
    return await ctx.db
      .query("renter_bot_drafts")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .order("desc")
      .take(limit ?? 20);
  },
});

/**
 * Returns the latest pending draft for a thread, or null. Used by the
 * Phase 1 workflow's idempotency check at enrich-time.
 */
export const getLatestPending = query({
  args: { thread_id: v.string() },
  handler: async (ctx, { thread_id }) => {
    return await ctx.db
      .query("renter_bot_drafts")
      .withIndex("by_thread_status", (q) =>
        q.eq("thread_id", thread_id).eq("status", "pending"),
      )
      .order("desc")
      .first();
  },
});
