import { v } from "convex/values";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { __service_getLatestActivityBatch } from "./hygglo";
import { setReservationActivityMode } from "./lib/reservation_activity_queries";
import { reservationActivityMatches, reservationActivityMetadata, reservationReadGate, reservationReadProgress } from "./lib/reservation_read_model";
import { cacheValueDigest } from "./lib/lossless_cache_codec";

export const status = internalQuery({ args: {}, handler: async ctx => ({ gate: await reservationReadGate(ctx), progress: await reservationReadProgress(ctx) }) });
export const start = internalMutation({ args: {}, handler: async ctx => {
  const gate = await reservationReadGate(ctx), progress = await reservationReadProgress(ctx);
  if (!gate?.ready || !gate.enabled || !progress || gate.activity_enabled) throw Error("Activity preparation requires a healthy source model and disabled activity serving");
  await ctx.db.patch(progress._id, { activity_stage: "backfill", activity_cursor: null });
  return { started: true };
} });
/** Derive only index metadata in the same source transaction. No rental writes,
 * compressed-record rebuilds, scheduler or provider import is involved. */
export const step = internalMutation({ args: {}, handler: async ctx => {
  const gate = await reservationReadGate(ctx), progress = await reservationReadProgress(ctx);
  if (!gate?.ready || !gate.enabled || gate.activity_enabled || !progress || !progress.activity_stage || progress.activity_stage === "prepared") throw Error("Activity preparation is not active");
  if (progress.activity_stage === "backfill") {
    const page = await ctx.db.query("reservations").paginate({ cursor: progress.activity_cursor ?? null, numItems: 80 });
    let written = 0;
    for (const source of page.page) {
      const presence = await ctx.db.query("reservation_order_presence").withIndex("by_source", q => q.eq("source_id", source._id)).unique();
      if (reservationActivityMatches(presence, source)) continue;
      const value = { source_id: source._id, ...(source.hygglo_order_id === undefined ? {} : { hygglo_order_id: source.hygglo_order_id }), ...reservationActivityMetadata(source) };
      if (presence) await ctx.db.replace(presence._id, value); else await ctx.db.insert("reservation_order_presence", value);
      written++;
    }
    await ctx.db.patch(progress._id, { activity_stage: page.isDone ? "prune" : "backfill", activity_cursor: page.isDone ? null : page.continueCursor });
    return { stage: "backfill", processed: page.page.length, written, done: false };
  }
  const page = await ctx.db.query("reservation_order_presence").paginate({ cursor: progress.activity_cursor ?? null, numItems: 80 });
  let removed = 0;
  for (const presence of page.page) if (!await ctx.db.get(presence.source_id)) { await ctx.db.delete(presence._id); removed++; }
  await ctx.db.patch(progress._id, { activity_stage: page.isDone ? "prepared" : "prune", activity_cursor: page.isDone ? null : page.continueCursor });
  return { stage: "prune", processed: page.page.length, removed, done: page.isDone };
} });
async function auditActivity(ctx: QueryCtx) {
  const gate = await reservationReadGate(ctx), progress = await reservationReadProgress(ctx);
  if (!gate?.ready || !gate.enabled || progress?.activity_stage !== "prepared") throw Error("Prepare activity metadata first");
  // One-time operator qualification, not a reactive/runtime scan. Current
  // source cardinality is 4,864; >6,000 stops qualification, never clips reads.
  const [sources, markers] = await Promise.all([ctx.db.query("reservations").take(6001), ctx.db.query("reservation_order_presence").take(6001)]);
  if (sources.length > 6000 || markers.length > 6000) throw Error("Activity audit exceeds its qualified bound");
  const bySource = new Map(markers.map(row => [String(row.source_id), row]));
  if (bySource.size !== markers.length || markers.length !== sources.length) throw Error("Activity presence coverage mismatch");
  for (const source of sources) if (!reservationActivityMatches(bySource.get(String(source._id)) ?? null, source)) throw Error("Activity source metadata mismatch");
  const ledger = sources.map(source => ({ source_id: source._id, ...(source.hygglo_order_id === undefined ? {} : { hygglo_order_id: source.hygglo_order_id }), ...reservationActivityMetadata(source) }));
  return { revision: progress.revision, count: sources.length, sha256: await cacheValueDigest(ledger) };
}
export const audit = internalQuery({ args: {}, handler: auditActivity });
export const enable = internalMutation({ args: { revision: v.number(), count: v.number(), sha256: v.string() }, handler: async (ctx, expected) => {
  const actual = await auditActivity(ctx);
  if (actual.revision !== expected.revision || actual.count !== expected.count || actual.sha256 !== expected.sha256) throw Error("Activity source changed; qualify again");
  const gate = await reservationReadGate(ctx);
  await ctx.db.patch(gate!._id, { activity_enabled: true });
  return { enabled: true, ...actual };
} });
export const disable = internalMutation({ args: {}, handler: async ctx => {
  const gate = await reservationReadGate(ctx);
  if (gate) await ctx.db.patch(gate._id, { activity_enabled: false });
  return { sourceReads: true };
} });
export const read = internalQuery({ args: { mode: v.union(v.literal("source"), v.literal("prepared")), hygglo_order_ids: v.array(v.string()) }, handler: async (ctx, args) => {
  setReservationActivityMode(ctx, args.mode);
  return (__service_getLatestActivityBatch as unknown as { _handler: (ctx: QueryCtx, args: { hygglo_order_ids: string[] }) => Promise<unknown> })._handler(ctx, { hygglo_order_ids: args.hygglo_order_ids });
} });
