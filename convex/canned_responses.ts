/**
 * Canned responses (Quick Reply, 2026-06-26) — per-account saved auto-replies
 * (delivery text, location, bank details, …). The chat renders each as a little
 * symbol button that pastes + sends the text after a confirm; the manage overlay
 * lists/edits them. All per `account_slug`.
 */
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

/** All canned responses for an account, ordered. */
export const list = query({
  args: { account_slug: v.optional(v.string()) },
  handler: async (ctx, { account_slug }) => {
    if (!account_slug) return [];
    const rows = await ctx.db
      .query("canned_responses")
      .withIndex("by_account", (q) => q.eq("account_slug", account_slug))
      .collect();
    return rows.sort((a, b) => a.sort - b.sort || a.created_at - b.created_at);
  },
});

/** Create a new canned response (appended to the end). */
export const create = mutation({
  args: {
    account_slug: v.string(),
    label: v.string(),
    symbol: v.string(),
    text: v.string(),
  },
  handler: async (ctx, { account_slug, label, symbol, text }) => {
    const existing = await ctx.db
      .query("canned_responses")
      .withIndex("by_account", (q) => q.eq("account_slug", account_slug))
      .collect();
    const maxSort = existing.reduce((m, r) => Math.max(m, r.sort), -1);
    const now = Date.now();
    return await ctx.db.insert("canned_responses", {
      account_slug,
      label: label.trim() || "Reply",
      symbol: symbol.trim() || "💬",
      text,
      sort: maxSort + 1,
      created_at: now,
      updated_at: now,
    });
  },
});

/** Edit an existing canned response (only the fields provided). */
export const update = mutation({
  args: {
    id: v.id("canned_responses"),
    label: v.optional(v.string()),
    symbol: v.optional(v.string()),
    text: v.optional(v.string()),
  },
  handler: async (ctx, { id, label, symbol, text }) => {
    const patch: Record<string, unknown> = { updated_at: Date.now() };
    if (label !== undefined) patch.label = label.trim() || "Reply";
    if (symbol !== undefined) patch.symbol = symbol.trim() || "💬";
    if (text !== undefined) patch.text = text;
    await ctx.db.patch(id, patch);
  },
});

export const remove = mutation({
  args: { id: v.id("canned_responses") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete(id);
  },
});
