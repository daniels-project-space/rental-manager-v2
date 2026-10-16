import { anyApi } from "convex/server";
import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { cacheByteDigest, canonicalCacheJson, cloneCacheValue, unpackCacheValue } from "./lossless_cache_codec";

export const WEEKLY_INPUT_KEY = "recent:v1" as const;
export type WeeklySnapshot = { covered_from: string; rows: Doc<"weekly_metrics">[] };
export async function sourceWeeklyRows(ctx: Pick<QueryCtx, "db">, from: string) {
  return ctx.db.query("weekly_metrics").withIndex("by_week_account_granularity", q => q.gte("week_start", from)).collect();
}
export async function captureWeeklyInputs(ctx: QueryCtx): Promise<WeeklySnapshot> {
  // Seven extra days cover the moving 90-day cutoff. Advancing the clock only
  // filters records out; newly written weeks invalidate before they are visible.
  const covered_from = new Date(Date.now() - 97 * 86_400_000).toISOString().slice(0, 10);
  const rows = await ctx.db.query("weekly_metrics").withIndex("by_week_account_granularity", q => q.gte("week_start", covered_from)).take(2001);
  if (rows.length > 2000) throw Error("permanent: weekly inputs exceed row bound; use source reads");
  return { covered_from, rows };
}

type Scope = { tail: Promise<void>; dirty: boolean; state?: Doc<"weekly_input_cache_state"> | null };
const mutations = new WeakMap<object, Scope>();
async function invalidate(ctx: MutationCtx, change: (from?: string) => boolean | Promise<boolean>) {
  let scope = mutations.get(ctx);
  if (!scope) { scope = { tail: Promise.resolve(), dirty: false }; mutations.set(ctx, scope); }
  const current = scope;
  const next = current.tail.then(async () => {
    if (current.dirty) return;
    if (current.state === undefined) current.state = await ctx.db.query("weekly_input_cache_state").withIndex("by_key", q => q.eq("key", WEEKLY_INPUT_KEY)).unique();
    const state = current.state;
    if (!state || (!state.enabled && !state.queued && state.ready_revision !== state.revision) || !await change(state.covered_from)) return;
    const queue = state.enabled && !state.queued, token = queue ? state.job_token + 1 : state.job_token;
    await ctx.db.patch(state._id, { revision: state.revision + 1, updated_at: Date.now(), ...(queue ? { queued: true, job_token: token, attempts: 0, error: undefined } : {}) });
    reads.delete(ctx);
    if (queue) await ctx.scheduler.runAfter(5_000, anyApi.weekly_input_cache_admin.refresh, { token });
    current.dirty = true;
  });
  current.tail = next; return next;
}
const covered = (week: string, from?: string) => from === undefined || week >= from;
export async function patchWeeklyMetric(ctx: MutationCtx, id: Id<"weekly_metrics">, patch: Partial<WithoutSystemFields<Doc<"weekly_metrics">>>, known?: Doc<"weekly_metrics">) {
  if (known && known._id !== id) throw Error("Known weekly metric does not match the write");
  await invalidate(ctx, async from => {
    const before = known ?? await ctx.db.get(id);
    return !!before && (covered(before.week_start, from) || covered(patch.week_start ?? before.week_start, from)) && Object.entries(patch).some(([key, value]) => {
      const previous = before[key as keyof typeof before];
      return previous === undefined || value === undefined ? previous !== value : canonicalCacheJson(previous) !== canonicalCacheJson(value);
    });
  });
  await ctx.db.patch(id, patch);
}
export async function insertWeeklyMetric(ctx: MutationCtx, row: WithoutSystemFields<Doc<"weekly_metrics">>) {
  await invalidate(ctx, from => covered(row.week_start, from));
  return ctx.db.insert("weekly_metrics", row);
}
export async function deleteWeeklyMetric(ctx: MutationCtx, id: Id<"weekly_metrics">, known?: Doc<"weekly_metrics">) {
  if (known && known._id !== id) throw Error("Known weekly metric does not match the write");
  await invalidate(ctx, async from => { const before = known ?? await ctx.db.get(id); return !!before && covered(before.week_start, from); });
  await ctx.db.delete(id);
}

const reads = new WeakMap<object, Promise<WeeklySnapshot | null>>(), prepared = new WeakSet<object>(), sourceOnly = new WeakSet<object>();
export async function withSourceWeeklyInputs<T>(ctx: QueryCtx, work: () => Promise<T>) { sourceOnly.add(ctx); reads.delete(ctx); return work(); }
export async function withPreparedWeeklyInputs<T>(ctx: QueryCtx, work: () => Promise<T>) { prepared.add(ctx); reads.delete(ctx); await loadWeeklyInputSnapshot(ctx); return work(); }
export function loadWeeklyInputSnapshot(ctx: Pick<QueryCtx, "db">): Promise<WeeklySnapshot | null> {
  if (sourceOnly.has(ctx)) return Promise.resolve(null);
  const existing = reads.get(ctx); if (existing) return existing;
  const pending = (async () => {
    try {
      const state = await ctx.db.query("weekly_input_cache_state").withIndex("by_key", q => q.eq("key", WEEKLY_INPUT_KEY)).unique();
      if (!state || (!state.enabled && !prepared.has(ctx)) || state.ready_revision !== state.revision) throw Error("Weekly inputs are not current");
      const blob = await ctx.db.query("weekly_input_cache_blobs").withIndex("by_key", q => q.eq("key", WEEKLY_INPUT_KEY)).unique();
      if (!blob || blob.version !== 1 || blob.revision !== state.revision || blob.covered_from !== state.covered_from || await cacheByteDigest(blob.data) !== blob.packed_sha256) throw Error("Weekly input artifact mismatch");
      const value = unpackCacheValue(blob.data) as unknown as WeeklySnapshot;
      if (!value || value.covered_from !== blob.covered_from || !Array.isArray(value.rows)) throw Error("Invalid weekly input payload");
      return value;
    } catch (error) { if (prepared.has(ctx)) throw error; return null; }
  })();
  reads.set(ctx, pending); return pending;
}
export async function loadWeeklyMetricRows(ctx: Pick<QueryCtx, "db">, from: string) {
  const snapshot = await loadWeeklyInputSnapshot(ctx);
  if (snapshot && from >= snapshot.covered_from) return cloneCacheValue(snapshot.rows.filter(row => row.week_start >= from));
  if (prepared.has(ctx)) throw Error("Requested weekly history is outside the prepared coverage");
  return sourceWeeklyRows(ctx, from);
}
