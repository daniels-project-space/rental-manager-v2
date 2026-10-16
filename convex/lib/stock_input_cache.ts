import { anyApi } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import { cacheByteDigest, canonicalCacheJson, unpackCacheValue } from "./lossless_cache_codec";

export const STOCK_INPUT_KEY = "inputs:v1" as const;
export const stockStaticTables = ["items", "hygglo_product_index", "listing_resolution_override", "insurance_claims", "owner_unavailability", "vacation_periods"] as const;
export type StockStaticTable = typeof stockStaticTables[number];
export const stockReservationStatuses = ["confirmed", "ongoing", "pending_review"] as const;
export type StockInputSnapshot = { [T in StockStaticTable]: Doc<T>[] } & { reservations: Doc<"reservations">[] };

export async function captureStockInputs(ctx: QueryCtx): Promise<StockInputSnapshot> {
  const entries = await Promise.all(stockStaticTables.map(async (table) => {
    // Known cardinalities on 16 Oct 2026: 108 items, 408 overrides, 75 index rows,
    // 4 claims, no owner blocks or active vacations. Oversize inputs stay uncached.
    const rows = table === "vacation_periods"
      ? await ctx.db.query("vacation_periods").withIndex("by_active_start", (q) => q.eq("is_active", true)).take(2001)
      : await ctx.db.query(table).take(2001);
    if (rows.length > 2000) throw new Error("permanent: stock input exceeds row bound; use source reads");
    return [table, rows] as const;
  }));
  const reservations = [] as Doc<"reservations">[];
  for (const status of stockReservationStatuses) {
    const rows = await ctx.db.query("reservations").withIndex("by_status", (q) => q.eq("status", status)).take(2001);
    if (rows.length > 2000) throw new Error("permanent: active reservations exceed row bound; use source reads");
    reservations.push(...rows);
  }
  return { ...Object.fromEntries(entries), reservations } as StockInputSnapshot;
}

type Scope = { tail: Promise<void>; dirty: boolean; state?: Doc<"stock_input_cache_state"> | null };
const mutations = new WeakMap<object, Scope>();
/** One invalidation covers every source write in the same atomic transaction. */
export function invalidateStockWhen(ctx: MutationCtx, changes: () => boolean | Promise<boolean>): Promise<void> {
  let scope = mutations.get(ctx);
  if (!scope) { scope = { tail: Promise.resolve(), dirty: false }; mutations.set(ctx, scope); }
  const current = scope;
  const next = current.tail.then(async () => {
    if (current.dirty) return;
    if (current.state === undefined) current.state = await ctx.db.query("stock_input_cache_state").withIndex("by_key", (q) => q.eq("key", STOCK_INPUT_KEY)).unique();
    const state = current.state;
    if (!state || (!state.enabled && !state.queued && state.ready_revision !== state.revision)) return;
    if (!await changes()) return;
    const queue = state.enabled && !state.queued;
    const token = queue ? state.job_token + 1 : state.job_token;
    await ctx.db.patch(state._id, { revision: state.revision + 1, updated_at: Date.now(),
      ...(queue ? { queued: true, job_token: token, attempts: 0, error: undefined } : {}) });
    reads.delete(ctx);
    states.delete(ctx);
    if (queue) await ctx.scheduler.runAfter(0, anyApi.stock_input_cache_admin.refresh, { token });
    current.dirty = true;
  });
  current.tail = next;
  return next;
}

export function patchChangesStockRecord(before: Record<string, unknown>, patch: Record<string, unknown>) {
  return Object.entries(patch).some(([key, value]) => {
    const previous = before[key];
    if (previous === undefined || value === undefined) return previous !== value;
    return canonicalCacheJson(previous as never) !== canonicalCacheJson(value as never);
  });
}
type ReservationId = Id<"reservations"> | Id<"renter_bot_lab_bookings">;
export async function beforeReservationStockPatch(ctx: MutationCtx, id: ReservationId, patch: Record<string, unknown>) {
  if (ctx.db.normalizeId("reservations", id) === null) return;
  await invalidateStockWhen(ctx, async () => {
    const before = await ctx.db.get(id as Id<"reservations">);
    return !!before && (stockReservationStatuses.some((s) => s === before.status || s === patch.status)) && patchChangesStockRecord(before, patch);
  });
}
export async function beforeReservationStockDelete(ctx: MutationCtx, id: ReservationId) {
  if (ctx.db.normalizeId("reservations", id) === null) return;
  await invalidateStockWhen(ctx, async () => {
    const before = await ctx.db.get(id as Id<"reservations">);
    return !!before && stockReservationStatuses.some((s) => s === before.status);
  });
}

const reads = new WeakMap<object, Promise<StockInputSnapshot | null>>();
const states = new WeakMap<object, Promise<Doc<"stock_input_cache_state"> | null>>();
const prepared = new WeakSet<object>();
const sourceOnly = new WeakSet<object>();
export async function withSourceStockInputs<T>(ctx: QueryCtx, work: () => Promise<T>): Promise<T> {
  sourceOnly.add(ctx); reads.delete(ctx); return work();
}
export async function withPreparedStockInputs<T>(ctx: QueryCtx, work: () => Promise<T>): Promise<T> {
  prepared.add(ctx); reads.delete(ctx);
  await loadStockInputCache(ctx);
  return work();
}
export function loadStockInputCacheState(ctx: QueryCtx): Promise<Doc<"stock_input_cache_state"> | null> {
  const existing = states.get(ctx);
  if (existing) return existing;
  const pending = ctx.db.query("stock_input_cache_state")
    .withIndex("by_key", (q) => q.eq("key", STOCK_INPUT_KEY))
    .unique();
  states.set(ctx, pending);
  return pending;
}
export function loadStockInputCache(ctx: QueryCtx): Promise<StockInputSnapshot | null> {
  if (sourceOnly.has(ctx)) return Promise.resolve(null);
  const existing = reads.get(ctx); if (existing) return existing;
  const pending = (async () => {
    const strict = prepared.has(ctx);
    try {
      const state = await loadStockInputCacheState(ctx);
      if (!state || (!state.enabled && !strict) || state.ready_revision !== state.revision) throw Error("Stock inputs are not current");
      const blob = await ctx.db.query("stock_input_cache_blobs").withIndex("by_key", (q) => q.eq("key", STOCK_INPUT_KEY)).unique();
      if (!blob || blob.version !== 1 || blob.revision !== state.revision || await cacheByteDigest(blob.data) !== blob.packed_sha256) throw Error("Stock input artifact mismatch");
      const value = unpackCacheValue(blob.data) as unknown as StockInputSnapshot;
      if (!value || [...stockStaticTables, "reservations"].some((name) => !Array.isArray(value[name as keyof StockInputSnapshot]))) throw Error("Invalid stock input payload");
      return value;
    } catch (error) { if (strict) throw error; return null; }
  })();
  reads.set(ctx, pending); return pending;
}
