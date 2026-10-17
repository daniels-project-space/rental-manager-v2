import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { anyApi } from "convex/server";
import { cacheByteDigest, cloneCacheValue, unpackCacheValue } from "./lossless_cache_codec";

export const INVENTORY_READ_KEY = "full:v1" as const;
export const inventoryReadGate = (ctx: Pick<QueryCtx, "db">) => ctx.db.query("inventory_read_gate").withIndex("by_key", q => q.eq("key", INVENTORY_READ_KEY)).unique();
const modes = new WeakMap<object, "source" | "prepared">();
const reads = new WeakMap<object, Promise<Doc<"items">[]>>();
const writes = new WeakMap<object, { tail: Promise<void>; dirty: boolean }>();
export function setInventoryReadMode(ctx: QueryCtx, mode: "source" | "prepared") { modes.set(ctx, mode); reads.delete(ctx); }

/** One item-only revision/job for all physical-inventory edits in a transaction.
 * Stock/reservation refreshes never invalidate inventory subscribers. */
export async function dirtyInventoryWhen(ctx: MutationCtx, changes: () => boolean | Promise<boolean>) {
  let scope = writes.get(ctx);
  if (!scope) { scope = { tail: Promise.resolve(), dirty: false }; writes.set(ctx, scope); }
  const current = scope;
  const next = current.tail.then(async () => {
    if (current.dirty) return;
    const gate = await inventoryReadGate(ctx);
    if (!gate || !await changes()) return;
    const queue = !gate.queued;
    await ctx.db.patch(gate._id, { revision: gate.revision + 1, ...(queue ? { queued: true, error: undefined } : {}) });
    reads.delete(ctx); current.dirty = true;
    if (queue) await ctx.scheduler.runAfter(0, anyApi.inventory_read_admin.rebuild, {});
  });
  current.tail = next;
  await next;
}

export async function decodeInventoryRead(blob: Doc<"inventory_read_blob">, count: number): Promise<Doc<"items">[]> {
  if (blob.version !== 1 || await cacheByteDigest(blob.data) !== blob.packed_sha256) throw Error("Inventory artifact hash mismatch");
  const value = unpackCacheValue(blob.data) as Doc<"items">[];
  if (!Array.isArray(value) || value.length !== count || value.some(row => !row || typeof row._id !== "string" || typeof row._creationTime !== "number")) throw Error("Inventory artifact metadata mismatch");
  return value;
}

/** Complete original documents and original database order; no field projection.
 * Physical inventory was 108 rows at qualification. Above 2,000 rows, or for
 * stale/disabled/missing/corrupt artifacts, retain the existing full source
 * contract rather than clipping rows. Only item writes trigger this artifact. */
export async function readFullInventory(ctx: QueryCtx): Promise<Doc<"items">[]> {
  const source = () => ctx.db.query("items").collect();
  const mode = modes.get(ctx);
  if (mode === "source") return source();
  const load = async () => {
    try {
      const gate = await inventoryReadGate(ctx);
      if (!gate || !gate.enabled && mode !== "prepared" || gate.ready_revision !== gate.revision || gate.count === undefined) throw Error("Inventory artifact is not ready");
      const blob = await ctx.db.query("inventory_read_blob").withIndex("by_key", q => q.eq("key", INVENTORY_READ_KEY)).unique();
      if (!blob || blob.revision !== gate.revision) throw Error("Inventory artifact revision mismatch");
      return await decodeInventoryRead(blob, gate.count);
    } catch (error) { if (mode === "prepared") throw error; return source(); }
  };
  // Mutation contexts are structurally assignable to QueryCtx. Never memoize
  // across their source writes or make a stale read appear immutable.
  if ("insert" in ctx.db) return load();
  let pending = reads.get(ctx);
  if (!pending) { pending = load(); reads.set(ctx, pending); }
  return cloneCacheValue(await pending);
}
