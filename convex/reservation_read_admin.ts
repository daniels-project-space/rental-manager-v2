import { __service_getThreadById, __service_getReplyQueue, getThreadContext } from "./replyInbox";
import { getRentalHeadlineStats, getRentalHeadlineCoreStats } from "./dashboard";
import { getGanttWeek } from "./calendar";
import { getDueReturns, listForReconcile, listActiveForStorefront } from "./reservations";
import { threadsNeedingListing } from "./inquiry_context";
import { sourceReservationReadContext, preparedReservationReadContext } from "./lib/reservation_read_queries";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { RESERVATION_READ_KEY, reservationReadGate, reservationReadProgress, syncReservationReadRecord, reservationReadRecordMatches, reservationActivityMatches } from "./lib/reservation_read_model";

export const status = internalQuery({ args: {}, handler: async ctx => ({ gate: await reservationReadGate(ctx), progress: await reservationReadProgress(ctx) }) });
export const start = internalMutation({ args: {}, handler: async ctx => {
  const gate = await reservationReadGate(ctx), progress = await reservationReadProgress(ctx);
  if (gate?.enabled) throw Error("Disable reservation read model before rebuilding");
  if (gate) await ctx.db.patch(gate._id, { ready: false });
  else await ctx.db.insert("reservation_read_gate", { key: RESERVATION_READ_KEY, version: 1, enabled: false, ready: false });
  const value = { key: RESERVATION_READ_KEY, revision: progress?.revision ?? 0, stage: "backfill" as const, cursor: null, audited_count: 0, audited_fallback_count: 0, copied_count: 0, pruned_count: 0 };
  if (progress) await ctx.db.replace(progress._id, value); else await ctx.db.insert("reservation_read_progress", value);
  return { started: true };
} });
/** Each page reads and writes the same source transaction: concurrent changes
 * cannot publish an old compressed record over a newer source write. */
export const step = internalMutation({ args: {}, handler: async ctx => {
  const gate = await reservationReadGate(ctx), progress = await reservationReadProgress(ctx);
  if (!gate || gate.enabled || !progress || progress.stage === "prepared") throw Error("Reservation preparation is not active");
  if (progress.stage === "backfill") {
    const page = await ctx.db.query("reservations").paginate({ cursor: progress.cursor, numItems: 40 });
    for (const row of page.page) await syncReservationReadRecord(ctx, row._id, false, row);
    await ctx.db.patch(progress._id, { copied_count: progress.copied_count + page.page.length, cursor: page.isDone ? null : page.continueCursor, stage: page.isDone ? "prune" : "backfill" });
    return { stage: "backfill", processed: page.page.length, done: page.isDone };
  }
  if (progress.stage === "prune") {
    const page = await ctx.db.query("reservation_read_records").paginate({ cursor: progress.cursor, numItems: 80 });
    let removed = 0;
    for (const row of page.page) if (!await ctx.db.get(row.source_id)) { await ctx.db.delete(row._id); removed++; }
    await ctx.db.patch(progress._id, { pruned_count: progress.pruned_count + removed, cursor: page.isDone ? null : page.continueCursor, stage: page.isDone ? "prunePresence" : "prune" });
    return { stage: "prune", processed: page.page.length, removed, done: page.isDone };
  }
  if (progress.stage === "prunePresence") {
    const page = await ctx.db.query("reservation_order_presence").paginate({ cursor: progress.cursor, numItems: 80 });
    let removed = 0;
    for (const row of page.page) if (!await ctx.db.get(row.source_id)) { await ctx.db.delete(row._id); removed++; }
    await ctx.db.patch(progress._id, { pruned_count: progress.pruned_count + removed, cursor: page.isDone ? null : page.continueCursor, stage: page.isDone ? "audit" : "prunePresence", ...(page.isDone ? { audited_revision: progress.revision, audited_count: 0, audited_fallback_count: 0 } : {}) });
    return { stage: "prunePresence", processed: page.page.length, removed, done: page.isDone };
  }
  if (progress.audited_revision !== progress.revision) {
    await ctx.db.patch(progress._id, { audited_revision: progress.revision, audited_count: 0, audited_fallback_count: 0, cursor: null });
    return { stage: "audit", restarted: true, revision: progress.revision };
  }
  const page = await ctx.db.query("reservations").paginate({ cursor: progress.cursor, numItems: 40 });
  let fallbackCount = 0;
  for (const source of page.page) {
    const record = await ctx.db.query("reservation_read_records").withIndex("by_source", q => q.eq("source_id", source._id)).unique();
    const presence = await ctx.db.query("reservation_order_presence").withIndex("by_source", q => q.eq("source_id", source._id)).unique();
    if (!reservationActivityMatches(presence, source) || !await reservationReadRecordMatches(record, source)) throw Error("Reservation read-model source audit failed");
    if (record && !record.valid) fallbackCount++;
  }
  await ctx.db.patch(progress._id, { audited_count: progress.audited_count + page.page.length, audited_fallback_count: progress.audited_fallback_count + fallbackCount, cursor: page.isDone ? null : page.continueCursor, stage: page.isDone ? "prepared" : "audit" });
  if (page.isDone) await ctx.db.patch(gate._id, { ready: true });
  return { stage: "audit", processed: page.page.length, done: page.isDone, revision: progress.revision };
} });
export const enable = internalMutation({ args: { revision: v.number(), count: v.number() }, handler: async (ctx, args) => {
  const gate = await reservationReadGate(ctx), progress = await reservationReadProgress(ctx);
  if (!gate?.ready || progress?.stage !== "prepared" || progress.revision !== args.revision || progress.audited_revision !== args.revision || progress.audited_count !== args.count) throw Error("Reservations changed; qualify again");
  await ctx.db.patch(gate._id, { enabled: true });
  return { enabled: true, revision: args.revision, auditedCount: args.count, fallbackCount: progress.audited_fallback_count };
} });
export const disable = internalMutation({ args: {}, handler: async ctx => {
  const gate = await reservationReadGate(ctx); if (gate) await ctx.db.patch(gate._id, { enabled: false });
  return { sourceReads: true };
} });

export const reaudit = internalMutation({ args: {}, handler: async ctx => {
  const gate = await reservationReadGate(ctx), progress = await reservationReadProgress(ctx);
  if (!gate || gate.enabled || progress?.stage !== "prepared") throw Error("Finish or restart disabled reservation preparation first");
  await ctx.db.patch(gate._id, { ready: false });
  await ctx.db.patch(progress._id, { stage: "prune", cursor: null, audited_count: 0, audited_fallback_count: 0, audited_revision: undefined });
  return { auditing: true };
} });

export const read = internalQuery({ args: {
  mode: v.union(v.literal("source"), v.literal("prepared")),
  kind: v.union(v.literal("thread"), v.literal("queue"), v.literal("context"), v.literal("headline"), v.literal("headlineCore"), v.literal("calendar"), v.literal("returns"), v.literal("reconcile"), v.literal("activeStorefront"), v.literal("inquiries")), args: v.any(),
}, handler: async (ctx, request) => {
  if (request.mode === "prepared" && !(await reservationReadGate(ctx))?.ready) throw Error("Prepare and audit reservation records first");
  const services = { thread: __service_getThreadById, queue: __service_getReplyQueue, context: getThreadContext, headline: getRentalHeadlineStats, headlineCore: getRentalHeadlineCoreStats, calendar: getGanttWeek, returns: getDueReturns, reconcile: listForReconcile, activeStorefront: listActiveForStorefront, inquiries: threadsNeedingListing };
  const service = services[request.kind] as unknown as { _handler: (ctx: QueryCtx, args: any) => Promise<any> };
  const context = request.mode === "source" ? sourceReservationReadContext({ ...ctx }) : preparedReservationReadContext({ ...ctx });
  return service._handler(context, request.kind === "queue" ? { ...request.args, _bypassMv: true } : request.args);
} });
