/**
 * Wave 4.7 — Convex helpers for the monthly model auto-upgrade scanner.
 *
 * The Trigger.dev task at `src/trigger/model-auto-upgrade.ts` calls
 * `recordScan` after every scan (whether it bumped, surfaced an advisory,
 * or errored). The dashboard chat agent reads pending advisories via
 * `listOpenAdvisories` (wired up as the `get_model_upgrade_advisories`
 * Mastra tool).
 */
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const RECOMMENDATION = v.union(
  v.literal("no_change"),
  v.literal("auto_pr"),
  v.literal("advisory"),
  v.literal("error"),
);

export const recordScan = mutation({
  args: {
    scannedAt: v.number(),
    currentModel: v.string(),
    availableModels: v.array(v.string()),
    recommendation: RECOMMENDATION,
    recommendedModel: v.optional(v.string()),
    prUrl: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("model_upgrade_scans", args);
  },
});

export const listOpenAdvisories = query({
  args: {
    sinceMs: v.optional(v.number()),       // default: last 90 days
  },
  handler: async (ctx, args) => {
    const cutoff = args.sinceMs ?? Date.now() - 90 * 24 * 60 * 60 * 1000;
    const rows = await ctx.db
      .query("model_upgrade_scans")
      .withIndex("by_scannedAt", (q) => q.gte("scannedAt", cutoff))
      .order("desc")
      .collect();
    return rows
      .filter((r) => r.recommendation === "advisory" && !r.dismissedAt)
      .map((r) => ({
        _id: r._id,
        scannedAt: r.scannedAt,
        currentModel: r.currentModel,
        availableModels: r.availableModels,
        recommendedModel: r.recommendedModel ?? null,
        errorMessage: r.errorMessage ?? null,
      }));
  },
});

export const listRecentScans = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 12;
    const rows = await ctx.db
      .query("model_upgrade_scans")
      .withIndex("by_scannedAt")
      .order("desc")
      .take(limit);
    return rows;
  },
});

export const dismissAdvisory = mutation({
  args: { id: v.id("model_upgrade_scans") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { dismissedAt: Date.now() });
  },
});
