import { anyApi } from "convex/server";
import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { cacheByteDigest, canonicalCacheJson, cloneCacheValue, unpackCacheValue } from "./lossless_cache_codec";

export const PRICING_INPUT_KEY = "all:v1" as const;
export async function sourcePricingRows(ctx: Pick<QueryCtx, "db">) { return ctx.db.query("pricing_catalog").collect(); }
export async function capturePricingInputs(ctx: QueryCtx) {
  // 474 records at qualification. Bound artifact preparation; the original
  // source path preserves every record when a cache cannot be used.
  const rows = await ctx.db.query("pricing_catalog").take(2001);
  if (rows.length > 2000) throw Error("permanent: pricing inputs exceed row bound; use source reads");
  return rows;
}

type Scope = { tail: Promise<void>; dirty: boolean; state?: Doc<"pricing_input_cache_state"> | null };
const mutations = new WeakMap<object, Scope>();
async function invalidate(ctx: MutationCtx, changes: () => boolean | Promise<boolean>) {
  let scope = mutations.get(ctx);
  if (!scope) { scope = { tail: Promise.resolve(), dirty: false }; mutations.set(ctx, scope); }
  const current = scope;
  const next = current.tail.then(async () => {
    if (current.dirty) return;
    if (current.state === undefined) current.state = await ctx.db.query("pricing_input_cache_state").withIndex("by_key", q => q.eq("key", PRICING_INPUT_KEY)).unique();
    const state = current.state;
    if (!state || (!state.enabled && !state.queued && state.ready_revision !== state.revision) || !await changes()) return;
    const queue = state.enabled && !state.queued, token = queue ? state.job_token + 1 : state.job_token;
    await ctx.db.patch(state._id, { revision: state.revision + 1, updated_at: Date.now(), ...(queue ? { queued: true, job_token: token, attempts: 0, error: undefined } : {}) });
    reads.delete(ctx);
    if (queue) await ctx.scheduler.runAfter(5_000, anyApi.pricing_input_cache_admin.refresh, { token });
    current.dirty = true;
  });
  current.tail = next; return next;
}
export async function patchPricingInput(ctx: MutationCtx, id: Id<"pricing_catalog">, patch: Partial<WithoutSystemFields<Doc<"pricing_catalog">>>, known?: Doc<"pricing_catalog">) {
  if (known && known._id !== id) throw Error("Known price row does not match the write");
  await invalidate(ctx, async () => {
    const before = known ?? await ctx.db.get(id);
    return !!before && Object.entries(patch).some(([key, value]) => {
      const previous = before[key as keyof typeof before];
      return previous === undefined || value === undefined ? previous !== value : canonicalCacheJson(previous) !== canonicalCacheJson(value);
    });
  });
  await ctx.db.patch(id, patch);
}
export async function insertPricingInput(ctx: MutationCtx, row: WithoutSystemFields<Doc<"pricing_catalog">>) {
  await invalidate(ctx, () => true); return ctx.db.insert("pricing_catalog", row);
}
export async function deletePricingInput(ctx: MutationCtx, id: Id<"pricing_catalog">, known?: Doc<"pricing_catalog">) {
  if (known && known._id !== id) throw Error("Known price row does not match the write");
  await invalidate(ctx, async () => (known ?? await ctx.db.get(id)) !== null); await ctx.db.delete(id);
}

const reads = new WeakMap<object, Promise<Doc<"pricing_catalog">[] | null>>(), prepared = new WeakSet<object>(), sourceOnly = new WeakSet<object>();
export async function withSourcePricingInputs<T>(ctx: QueryCtx, work: () => Promise<T>) { sourceOnly.add(ctx); reads.delete(ctx); return work(); }
export async function withPreparedPricingInputs<T>(ctx: QueryCtx, work: () => Promise<T>) { prepared.add(ctx); reads.delete(ctx); await loadPricingSnapshot(ctx); return work(); }
export function loadPricingSnapshot(ctx: Pick<QueryCtx, "db">): Promise<Doc<"pricing_catalog">[] | null> {
  if (sourceOnly.has(ctx)) return Promise.resolve(null);
  const existing = reads.get(ctx); if (existing) return existing;
  const pending = (async () => {
    try {
      const state = await ctx.db.query("pricing_input_cache_state").withIndex("by_key", q => q.eq("key", PRICING_INPUT_KEY)).unique();
      if (!state || (!state.enabled && !prepared.has(ctx)) || state.ready_revision !== state.revision) throw Error("Pricing inputs are not current");
      const blob = await ctx.db.query("pricing_input_cache_blobs").withIndex("by_key", q => q.eq("key", PRICING_INPUT_KEY)).unique();
      if (!blob || blob.version !== 1 || blob.revision !== state.revision || await cacheByteDigest(blob.data) !== blob.packed_sha256) throw Error("Pricing input artifact mismatch");
      const rows = unpackCacheValue(blob.data);
      if (!Array.isArray(rows)) throw Error("Invalid pricing input payload");
      return rows as Doc<"pricing_catalog">[];
    } catch (error) { if (prepared.has(ctx)) throw error; return null; }
  })();
  reads.set(ctx, pending); return pending;
}
export async function loadPricingRows(ctx: Pick<QueryCtx, "db">) {
  const rows = await loadPricingSnapshot(ctx);
  return rows ? cloneCacheValue(rows) : sourcePricingRows(ctx);
}
