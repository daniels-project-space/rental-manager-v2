import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { anyApi } from "convex/server";
import { v, type Value } from "convex/values";
import { INVENTORY_READ_KEY, decodeInventoryRead, inventoryReadGate, readFullInventory, setInventoryReadMode } from "./lib/inventory_read";
import { cacheByteDigest, cacheValueDigest, canonicalCacheJson, packCacheValue, unpackCacheValue } from "./lib/lossless_cache_codec";
import { __service_getGanttWeek } from "./calendar";
import { __service_getDueReturns } from "./reservations";
import { __service_getNextRentals } from "./dashboard";

/** Item edits and explicit recovery are the only triggers. One atomic bounded
 * mutation captures and publishes the complete inventory in database order. */
export const rebuild = internalMutation({ args: {}, handler: async (ctx) => {
  const gate = await inventoryReadGate(ctx);
  if (!gate?.queued) return { rebuilt: false };
  const items = await ctx.db.query("items").take(2001);
  try {
    if (items.length > 2000) throw Error("permanent: inventory exceeds 2000-row bound; retain source reads");
    const data = packCacheValue(items);
    if (canonicalCacheJson(unpackCacheValue(data)) !== canonicalCacheJson(items)) throw Error("permanent: inventory codec mismatch");
    const prior = await ctx.db.query("inventory_read_blob").withIndex("by_key", q => q.eq("key", INVENTORY_READ_KEY)).unique();
    const value = { key: INVENTORY_READ_KEY, version: 1 as const, revision: gate.revision, data, source_sha256: await cacheValueDigest(items), packed_sha256: await cacheByteDigest(data) };
    if (prior) await ctx.db.replace(prior._id, value); else await ctx.db.insert("inventory_read_blob", value);
    await ctx.db.patch(gate._id, { ready_revision: gate.revision, count: items.length, queued: false, error: undefined });
    return { rebuilt: true, revision: gate.revision, count: items.length, bytes: data.byteLength, source_sha256: value.source_sha256 };
  } catch (error) {
    if (!String(error).includes("permanent:")) throw error;
    await ctx.db.patch(gate._id, { ready_revision: undefined, queued: false, error: String(error) });
    return { rebuilt: false, error: String(error) };
  }
} });
export const prepare = internalMutation({ args: { recoverQueued: v.optional(v.boolean()) }, handler: async (ctx, args) => {
  const gate = await inventoryReadGate(ctx);
  if (gate?.queued && !args.recoverQueued) return { queued: true };
  if (gate) await ctx.db.patch(gate._id, { queued: true, ready_revision: undefined, error: undefined });
  else await ctx.db.insert("inventory_read_gate", { key: INVENTORY_READ_KEY, revision: 0, enabled: false, queued: true });
  await ctx.scheduler.runAfter(0, anyApi.inventory_read_admin.rebuild, {});
  return { queued: true };
} });
export const status = internalQuery({ args: {}, handler: async (ctx) => {
  const gate = await inventoryReadGate(ctx);
  const blob = await ctx.db.query("inventory_read_blob").withIndex("by_key", q => q.eq("key", INVENTORY_READ_KEY)).unique();
  return { gate, blob: blob ? { revision: blob.revision, bytes: blob.data.byteLength, source_sha256: blob.source_sha256 } : null };
} });
export const audit = internalQuery({ args: {}, handler: async (ctx) => {
  const source = await ctx.db.query("items").take(2001);
  if (source.length > 2000) throw Error("Inventory audit exceeds bound");
  const prepared = { ...ctx }; setInventoryReadMode(prepared, "prepared");
  const value = await readFullInventory(prepared), gate = await inventoryReadGate(ctx);
  return { equal: canonicalCacheJson(source) === canonicalCacheJson(value), revision: gate?.revision, count: source.length, source_sha256: await cacheValueDigest(source), prepared_sha256: await cacheValueDigest(value) };
} });
export const enable = internalMutation({ args: { revision: v.number(), source_sha256: v.string() }, handler: async (ctx, args) => {
  const gate = await inventoryReadGate(ctx);
  const blob = await ctx.db.query("inventory_read_blob").withIndex("by_key", q => q.eq("key", INVENTORY_READ_KEY)).unique();
  if (!gate || gate.queued || gate.revision !== args.revision || gate.ready_revision !== args.revision || gate.count === undefined || !blob || blob.revision !== args.revision || blob.source_sha256 !== args.source_sha256) throw Error("Inventory changed; audit again");
  const source = await ctx.db.query("items").take(2001), value = await decodeInventoryRead(blob, gate.count);
  if (source.length > 2000 || await cacheValueDigest(source) !== args.source_sha256 || canonicalCacheJson(source) !== canonicalCacheJson(value)) throw Error("Inventory source changed; audit again");
  await ctx.db.patch(gate._id, { enabled: true });
  return { enabled: true, revision: args.revision, count: source.length };
} });
export const disable = internalMutation({ args: {}, handler: async (ctx) => {
  const gate = await inventoryReadGate(ctx); if (gate) await ctx.db.patch(gate._id, { enabled: false });
} });

const fields = { kind: v.union(v.literal("gantt"), v.literal("due"), v.literal("handoff")), accountSlug: v.union(v.string(), v.null()), weekStartIso: v.optional(v.string()), day: v.optional(v.union(v.literal("today"), v.literal("tomorrow"))), bypassMv: v.optional(v.boolean()) };
type Args = { kind: "gantt" | "due" | "handoff"; accountSlug: string | null; weekStartIso?: string; day?: "today" | "tomorrow"; bypassMv?: boolean };
async function service(ctx: QueryCtx, args: Args): Promise<Value> {
  const handler = (fn: unknown) => (fn as { _handler: (ctx: QueryCtx, args: unknown) => Promise<Value> })._handler;
  if (args.kind === "gantt") return handler(__service_getGanttWeek)(ctx, { accountSlug: args.accountSlug, weekStartIso: args.weekStartIso });
  if (args.kind === "due") return handler(__service_getDueReturns)(ctx, { accountSlug: args.accountSlug, _bypassMv: args.bypassMv });
  return handler(__service_getNextRentals)(ctx, { accountSlug: args.accountSlug, day: args.day ?? "today" });
}
export const read = internalQuery({ args: { ...fields, mode: v.union(v.literal("source"), v.literal("prepared")) }, handler: async (ctx, args) => {
  setInventoryReadMode(ctx, args.mode); return service(ctx, args);
} });
export const auditHandlers = internalQuery({ args: fields, handler: async (ctx, args) => {
  const raw = { ...ctx }, prepared = { ...ctx }; setInventoryReadMode(raw, "source"); setInventoryReadMode(prepared, "prepared");
  const [a, b] = await Promise.all([service(raw, args), service(prepared, args)]);
  return { equal: canonicalCacheJson(a) === canonicalCacheJson(b), source_sha256: await cacheValueDigest(a), prepared_sha256: await cacheValueDigest(b) };
} });
