import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { list } from "./hygglo_products";
import { PRODUCT_READ_KEY, productReadGate, productReadProgress, syncProductReadRecord, productReadRecordMatches, setProductReadMode } from "./lib/product_read_model";
import type { QueryCtx } from "./_generated/server";

export const status = internalQuery({ args: {}, handler: async ctx => ({ gate: await productReadGate(ctx), progress: await productReadProgress(ctx) }) });
export const start = internalMutation({ args: {}, handler: async ctx => {
  const gate = await productReadGate(ctx), progress = await productReadProgress(ctx);
  if (gate?.enabled) throw Error("Disable product read model before rebuilding");
  if (gate) await ctx.db.patch(gate._id, { ready: false });
  else await ctx.db.insert("product_read_gate", { key: PRODUCT_READ_KEY, version: 1, enabled: false, ready: false });
  const value = { accounts: [], key: PRODUCT_READ_KEY, revision: progress?.revision ?? 0, stage: "backfill" as const, cursor: null, audited_count: 0, audited_fallback_count: 0, copied_count: 0, pruned_count: 0 };
  if (progress) await ctx.db.replace(progress._id, value); else await ctx.db.insert("product_read_progress", value);
  return { started: true };
} });
/** Each page reads and writes the same source transaction: concurrent changes
 * cannot publish an old compressed record over a newer source write. */
export const step = internalMutation({ args: {}, handler: async ctx => {
  const gate = await productReadGate(ctx), progress = await productReadProgress(ctx);
  if (!gate || gate.enabled || !progress || progress.stage === "prepared") throw Error("Product preparation is not active");
  if (progress.stage === "backfill") {
    const page = await ctx.db.query("hygglo_products").paginate({ cursor: progress.cursor, numItems: 40 });
    for (const row of page.page) await syncProductReadRecord(ctx, row._id, false, row);
    await ctx.db.patch(progress._id, { copied_count: progress.copied_count + page.page.length, cursor: page.isDone ? null : page.continueCursor, stage: page.isDone ? "prune" : "backfill" });
    return { stage: "backfill", processed: page.page.length, done: page.isDone };
  }
  if (progress.stage === "prune") {
    const page = await ctx.db.query("product_read_records").paginate({ cursor: progress.cursor, numItems: 80 });
    let removed = 0;
    for (const row of page.page) if (!await ctx.db.get(row.source_id)) { await ctx.db.delete(row._id); removed++; }
    await ctx.db.patch(progress._id, { pruned_count: progress.pruned_count + removed, cursor: page.isDone ? null : page.continueCursor, stage: page.isDone ? "audit" : "prune", ...(page.isDone ? { accounts: [], audited_revision: progress.revision, audited_count: 0, audited_fallback_count: 0 } : {}) });
    return { stage: "prune", processed: page.page.length, removed, done: page.isDone };
  }
  if (progress.audited_revision !== progress.revision) {
    await ctx.db.patch(progress._id, { accounts: [], audited_revision: progress.revision, audited_count: 0, audited_fallback_count: 0, cursor: null });
    return { stage: "audit", restarted: true, revision: progress.revision };
  }
  const page = await ctx.db.query("hygglo_products").paginate({ cursor: progress.cursor, numItems: 40 });
  let fallbackCount = 0;
  const counts = new Map(progress.accounts.map(row => [row.accountSlug, row.count]));
  for (const source of page.page) {
    const record = await ctx.db.query("product_read_records").withIndex("by_source", q => q.eq("source_id", source._id)).unique();
    if (!await productReadRecordMatches(record, source)) throw Error("Product read-model source audit failed");
    if (record && !record.valid) fallbackCount++;
    counts.set(source.accountSlug, (counts.get(source.accountSlug) ?? 0) + 1);
  }
  const accounts = [...counts].map(([accountSlug, count]) => ({ accountSlug, count }));
  await ctx.db.patch(progress._id, { accounts, audited_count: progress.audited_count + page.page.length, audited_fallback_count: progress.audited_fallback_count + fallbackCount, cursor: page.isDone ? null : page.continueCursor, stage: page.isDone ? "prepared" : "audit" });
  if (page.isDone) await ctx.db.patch(gate._id, { ready: true, accounts });
  return { stage: "audit", processed: page.page.length, done: page.isDone, revision: progress.revision };
} });
export const enable = internalMutation({ args: { revision: v.number(), count: v.number() }, handler: async (ctx, args) => {
  const gate = await productReadGate(ctx), progress = await productReadProgress(ctx);
  if (!gate?.ready || !gate.accounts || gate.accounts.reduce((sum, row) => sum + row.count, 0) !== args.count || progress?.stage !== "prepared" || progress.revision !== args.revision || progress.audited_revision !== args.revision || progress.audited_count !== args.count) throw Error("Products changed; qualify again");
  await ctx.db.patch(gate._id, { enabled: true });
  return { enabled: true, revision: args.revision, auditedCount: args.count, fallbackCount: progress.audited_fallback_count };
} });
export const disable = internalMutation({ args: {}, handler: async ctx => {
  const gate = await productReadGate(ctx); if (gate) await ctx.db.patch(gate._id, { enabled: false });
  return { sourceReads: true };
} });

export const reaudit = internalMutation({ args: {}, handler: async ctx => {
  const gate = await productReadGate(ctx), progress = await productReadProgress(ctx);
  if (!gate || gate.enabled || progress?.stage !== "prepared") throw Error("Finish or restart disabled product preparation first");
  await ctx.db.patch(gate._id, { ready: false });
  await ctx.db.patch(progress._id, { stage: "prune", cursor: null, accounts: [], audited_count: 0, audited_fallback_count: 0, audited_revision: undefined });
  return { auditing: true };
} });

export const read = internalQuery({ args: { mode: v.union(v.literal("source"), v.literal("prepared")), accountSlug: v.optional(v.string()) }, handler: async (ctx, args) => {
  const context = { ...ctx };
  setProductReadMode(context, args.mode);
  const service = list as unknown as { _handler: (ctx: QueryCtx, args: { accountSlug?: string }) => Promise<unknown> };
  return service._handler(context, { accountSlug: args.accountSlug });
} });
