/**
 * Wave 4.6 — Convex helpers for Hygglo UI automation.
 *
 * Three tables fronted here:
 *   1. hygglo_sessions       — cookie storage_state by accountSlug
 *   2. hygglo_ui_actions     — audit + idempotency rows per correlationId
 *   3. ui_cost_guards        — per-account per-day spend ledger
 *
 * Every write goes through internalMutation so only Trigger tasks +
 * the bootstrap script (via service-key) can touch them. The dashboard
 * agent reads via `getPendingShadowActions` (regular query).
 */
import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";

// ── 1. hygglo_sessions ──────────────────────────────────────────

export const upsertSession = mutation({
  args: {
    accountSlug: v.union(v.literal("dbcinema"), v.literal("leo")),
    storageStateJson: v.string(),
    expiresHintAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("hygglo_sessions")
      .withIndex("by_account", (q) => q.eq("accountSlug", args.accountSlug))
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        storageStateJson: args.storageStateJson,
        capturedAt: now,
        expiresHintAt: args.expiresHintAt,
      });
      return existing._id;
    }
    return await ctx.db.insert("hygglo_sessions", {
      accountSlug: args.accountSlug,
      storageStateJson: args.storageStateJson,
      capturedAt: now,
      expiresHintAt: args.expiresHintAt,
    });
  },
});

export const getSession = query({
  args: { accountSlug: v.union(v.literal("dbcinema"), v.literal("leo")) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("hygglo_sessions")
      .withIndex("by_account", (q) => q.eq("accountSlug", args.accountSlug))
      .unique();
  },
});

export const markSessionUsed = mutation({
  args: {
    accountSlug: v.union(v.literal("dbcinema"), v.literal("leo")),
    runId: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("hygglo_sessions")
      .withIndex("by_account", (q) => q.eq("accountSlug", args.accountSlug))
      .unique();
    if (!existing) return;
    await ctx.db.patch(existing._id, {
      lastUsedAt: Date.now(),
      lastUsedRunId: args.runId,
    });
  },
});

// ── 2. hygglo_ui_actions ────────────────────────────────────────

export const findByCorrelation = query({
  args: { correlationId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("hygglo_ui_actions")
      .withIndex("by_correlation", (q) => q.eq("correlationId", args.correlationId))
      .unique();
  },
});

export const insertActionAttempt = mutation({
  args: {
    correlationId: v.string(),
    accountSlug: v.string(),
    orderId: v.optional(v.string()),
    action: v.string(),
    args: v.any(),
    strategyUsed: v.union(
      v.literal("recipe"),
      v.literal("ai_fallback"),
      v.literal("ai_first"),
    ),
  },
  handler: async (ctx, args) => {
    // Idempotency: if a row already exists for this correlationId, return its id.
    const existing = await ctx.db
      .query("hygglo_ui_actions")
      .withIndex("by_correlation", (q) => q.eq("correlationId", args.correlationId))
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert("hygglo_ui_actions", {
      correlationId: args.correlationId,
      accountSlug: args.accountSlug,
      orderId: args.orderId,
      action: args.action,
      args: args.args,
      status: "queued",
      startedAt: Date.now(),
      strategyUsed: args.strategyUsed,
    });
  },
});

export const completeAction = mutation({
  args: {
    correlationId: v.string(),
    status: v.union(
      v.literal("running"),
      v.literal("shadow_complete"),
      v.literal("live_complete"),
      v.literal("failed"),
    ),
    strategyUsed: v.optional(
      v.union(
        v.literal("recipe"),
        v.literal("ai_fallback"),
        v.literal("ai_first"),
      ),
    ),
    llmCallCount: v.optional(v.number()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    estCostUsd: v.optional(v.number()),
    screenshotR2Key: v.optional(v.string()),
    screenshotUrl: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    hyggloConfirmationText: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("hygglo_ui_actions")
      .withIndex("by_correlation", (q) => q.eq("correlationId", args.correlationId))
      .unique();
    if (!row) {
      throw new Error(`completeAction: no row for correlation ${args.correlationId}`);
    }
    const patch: Record<string, unknown> = {
      status: args.status,
      completedAt: Date.now(),
    };
    for (const k of [
      "strategyUsed",
      "llmCallCount",
      "inputTokens",
      "outputTokens",
      "estCostUsd",
      "screenshotR2Key",
      "screenshotUrl",
      "errorMessage",
      "hyggloConfirmationText",
    ] as const) {
      if (args[k] !== undefined) patch[k] = args[k];
    }
    await ctx.db.patch(row._id, patch);
    return row._id;
  },
});

export const listShadowPending = query({
  args: { accountSlug: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;
    let rows;
    if (args.accountSlug) {
      const slug = args.accountSlug;
      rows = await ctx.db
        .query("hygglo_ui_actions")
        .withIndex("by_status_account", (q) =>
          q.eq("status", "shadow_complete").eq("accountSlug", slug),
        )
        .order("desc")
        .take(limit);
    } else {
      rows = await ctx.db
        .query("hygglo_ui_actions")
        .withIndex("by_startedAt")
        .order("desc")
        .take(limit * 2);
      rows = rows.filter((r) => r.status === "shadow_complete").slice(0, limit);
    }
    return rows.map((r) => ({
      correlationId: r.correlationId,
      accountSlug: r.accountSlug,
      orderId: r.orderId,
      action: r.action,
      args: r.args,
      screenshotUrl: r.screenshotUrl,
      hyggloConfirmationText: r.hyggloConfirmationText,
      strategyUsed: r.strategyUsed,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
    }));
  },
});

// ── 3. ui_cost_guards ──────────────────────────────────────────

export const getTodaysSpend = query({
  args: { accountSlug: v.string(), isoDate: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("ui_cost_guards")
      .withIndex("by_account_date", (q) =>
        q.eq("accountSlug", args.accountSlug).eq("isoDate", args.isoDate),
      )
      .unique();
    return row ? { spendUsd: row.spendUsd, actionCount: row.actionCount } : { spendUsd: 0, actionCount: 0 };
  },
});

export const addSpend = mutation({
  args: {
    accountSlug: v.string(),
    isoDate: v.string(),
    deltaUsd: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("ui_cost_guards")
      .withIndex("by_account_date", (q) =>
        q.eq("accountSlug", args.accountSlug).eq("isoDate", args.isoDate),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        spendUsd: existing.spendUsd + args.deltaUsd,
        actionCount: existing.actionCount + 1,
        updatedAt: Date.now(),
      });
      return existing.spendUsd + args.deltaUsd;
    }
    await ctx.db.insert("ui_cost_guards", {
      accountSlug: args.accountSlug,
      isoDate: args.isoDate,
      spendUsd: args.deltaUsd,
      actionCount: 1,
      updatedAt: Date.now(),
    });
    return args.deltaUsd;
  },
});
