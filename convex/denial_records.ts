import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

/** W16 Denial Recording - insert a denial record from the dashboard UI.
 *  Phase 9.2 — schedules an LLM-driven item_id resolution after insert so the
 *  Missed-Revenue pie can group by inventory kind instead of dumping to Unmatched. */
export const createDenial = mutation({
  args: {
    itemName: v.string(),
    reason: v.string(),
    estimatedValue: v.optional(v.number()),
    notes: v.optional(v.string()),
    accountSlug: v.optional(v.string()),
  },
  handler: async (ctx, { itemName, reason, estimatedValue, notes, accountSlug }) => {
    let accountId: import("./_generated/dataModel").Id<"accounts"> | undefined;
    if (accountSlug) {
      const acc = await ctx.db
        .query("accounts")
        .withIndex("by_slug", (q) => q.eq("slug", accountSlug))
        .first();
      accountId = acc?._id;
    }
    const id = await ctx.db.insert("denial_records", {
      account_id: accountId,
      reason,
      item_name: itemName,
      estimated_value: estimatedValue,
      notes,
      created_at: Date.now(),
    });
    // Phase 9.2 — async LLM resolution. Runs after the mutation commits so the
    // write isn't blocked by network latency. Mutations can't call actions
    // directly; scheduler.runAfter is the Convex-blessed pattern.
    await ctx.scheduler.runAfter(0, internal.denial_resolver.resolveItemFor, { id });
    return { ok: true, id };
  },
});

/** List recent denial records */
export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const take = limit ?? 10;
    const rows = await ctx.db.query("denial_records").order("desc").take(take);
    return rows.map((r) => ({
      id: r._id,
      accountId: r.account_id,
      itemName: r.item_name,
      reason: r.reason,
      estimatedValue: r.estimated_value,
      notes: r.notes,
      createdAt: r.created_at,
    }));
  },
});

/** Update a denial record */
export const update = mutation({
  args: {
    id: v.id("denial_records"),
    itemName: v.optional(v.string()),
    reason: v.optional(v.string()),
    estimatedValue: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, { id, ...fields }) => {
    const patch: Record<string, unknown> = {};
    if (fields.itemName !== undefined) patch.item_name = fields.itemName;
    if (fields.reason !== undefined) patch.reason = fields.reason;
    if (fields.estimatedValue !== undefined) patch.estimated_value = fields.estimatedValue;
    if (fields.notes !== undefined) patch.notes = fields.notes;
    await ctx.db.patch(id, patch);
    return { ok: true };
  },
});

/** Delete a denial record */
export const remove = mutation({
  args: { id: v.id("denial_records") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete(id);
    return { ok: true };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 9.2 — internal helpers consumed by the LLM resolver action.
// Mutations can't call actions; actions can call queries+mutations. So the
// resolver action reads the row via getById, calls the LLM, then patches the
// FK via patchItemId.
// ─────────────────────────────────────────────────────────────────────────────

/** Internal: fetch a denial row for the resolver action. */
export const getById = internalQuery({
  args: { id: v.id("denial_records") },
  handler: async (ctx, { id }) => {
    return await ctx.db.get(id);
  },
});

/** Internal: patch the resolved item_id (or mark as resolved-but-unmatched). */
export const patchItemId = internalMutation({
  args: {
    id: v.id("denial_records"),
    item_id: v.optional(v.id("items")),
    confidence: v.optional(v.number()),
  },
  handler: async (ctx, { id, item_id, confidence }) => {
    await ctx.db.patch(id, {
      item_id,
      item_resolved_at: Date.now(),
      item_resolution_confidence: confidence,
    });
  },
});

/** Internal: list denial rows that still need resolution (item_id unset and
 *  not previously attempted, OR previously attempted but never resolved — the
 *  resolver itself decides whether to retry based on item_resolved_at). */
export const listUnresolvedDenials = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const cap = limit ?? 50;
    const rows = await ctx.db
      .query("denial_records")
      .order("desc")
      .collect();
    // We want rows where item_id is undefined AND we haven't already tried
    // (item_resolved_at is undefined). This keeps retries idempotent — once
    // the resolver runs and writes item_resolved_at, we don't loop.
    const pending = rows.filter(
      (r) => r.item_id === undefined && r.item_resolved_at === undefined && (r.item_name ?? "").trim().length > 0,
    );
    return pending.slice(0, cap).map((r) => r._id);
  },
});

/** Public: kick off a backfill of all historical denials. Does NOT run
 *  automatically — operator triggers via:
 *    npx convex run denial_records:backfillResolveAll '{"limit": 50}'
 *  Scheduled in small batches to keep within Convex action budgets. */
export const backfillResolveAll = mutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const cap = limit ?? 50;
    const rows = await ctx.db
      .query("denial_records")
      .collect();
    const pending = rows.filter(
      (r) => r.item_id === undefined && r.item_resolved_at === undefined && (r.item_name ?? "").trim().length > 0,
    );
    const batch = pending.slice(0, cap);
    let scheduled = 0;
    for (const r of batch) {
      // Space out by 500ms so we don't fire N parallel LLM calls.
      await ctx.scheduler.runAfter(scheduled * 500, internal.denial_resolver.resolveItemFor, { id: r._id });
      scheduled++;
    }
    return { ok: true, scheduled, totalPending: pending.length };
  },
});
