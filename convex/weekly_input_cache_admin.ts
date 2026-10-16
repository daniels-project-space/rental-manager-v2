import { anyApi } from "convex/server";
import { v, type Value } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { getDashboardInsightBundle } from "./dashboard_insights";
import { WEEKLY_INPUT_KEY, captureWeeklyInputs, loadWeeklyInputSnapshot, sourceWeeklyRows, withPreparedWeeklyInputs, withSourceWeeklyInputs } from "./lib/weekly_input_cache";
import { cacheValueDigest, cacheByteDigest, canonicalCacheJson, packCacheValue, unpackCacheValue } from "./lib/lossless_cache_codec";

const readBundle = getDashboardInsightBundle as unknown as { _handler: (ctx: QueryCtx, args: { accountSlug: string | null }) => Promise<Value> };

export const status = internalQuery({ args: {}, handler: async ctx => {
  const state = await ctx.db.query("weekly_input_cache_state").withIndex("by_key", q => q.eq("key", WEEKLY_INPUT_KEY)).unique();
  const blob = await ctx.db.query("weekly_input_cache_blobs").withIndex("by_key", q => q.eq("key", WEEKLY_INPUT_KEY)).unique();
  return { state, blob: blob ? { revision: blob.revision, covered_from: blob.covered_from, sha256: blob.sha256, packed_sha256: blob.packed_sha256, bytes: blob.data.byteLength } : null };
} });
export const snapshot = internalQuery({ args: { token: v.number() }, handler: async (ctx, { token }) => {
  const state = await ctx.db.query("weekly_input_cache_state").withIndex("by_key", q => q.eq("key", WEEKLY_INPUT_KEY)).unique();
  if (!state?.queued || state.job_token !== token) return null;
  return { revision: state.revision, inputs: await captureWeeklyInputs(ctx) };
} });
export const publish = internalMutation({ args: { token: v.number(), revision: v.number(), covered_from: v.string(), data: v.bytes(), sha256: v.string(), packed_sha256: v.string() }, handler: async (ctx, args) => {
  const state = await ctx.db.query("weekly_input_cache_state").withIndex("by_key", q => q.eq("key", WEEKLY_INPUT_KEY)).unique();
  if (!state?.queued || state.job_token !== args.token) return false;
  if (state.revision !== args.revision) {
    if (state.attempts < 2) {
      const token = state.job_token + 1;
      await ctx.db.patch(state._id, { job_token: token, attempts: state.attempts + 1 });
      await ctx.scheduler.runAfter(30_000 * (state.attempts + 1), anyApi.weekly_input_cache_admin.refresh, { token });
    } else await ctx.db.patch(state._id, { enabled: false, queued: false, error: "Source kept changing; source reads remain active" });
    return false;
  }
  const prior = await ctx.db.query("weekly_input_cache_blobs").withIndex("by_key", q => q.eq("key", WEEKLY_INPUT_KEY)).unique();
  const { token: _token, ...contents } = args;
  const value = { key: WEEKLY_INPUT_KEY, version: 1 as const, ...contents };
  if (prior) await ctx.db.replace(prior._id, value); else await ctx.db.insert("weekly_input_cache_blobs", value);
  await ctx.db.patch(state._id, { covered_from: args.covered_from, ready_revision: args.revision, queued: false, attempts: 0, error: undefined, updated_at: Date.now() });
  return true;
} });
export const failed = internalMutation({ args: { token: v.number(), error: v.string() }, handler: async (ctx, { token, error }) => {
  const state = await ctx.db.query("weekly_input_cache_state").withIndex("by_key", q => q.eq("key", WEEKLY_INPUT_KEY)).unique();
  if (!state?.queued || state.job_token !== token) return;
  const retry = !error.includes("permanent:") && state.attempts < 2, nextToken = state.job_token + 1;
  await ctx.db.patch(state._id, { enabled: retry ? state.enabled : false, queued: retry, job_token: nextToken, attempts: state.attempts + 1, error: error.slice(0, 500), updated_at: Date.now() });
  if (retry) await ctx.scheduler.runAfter(30_000 * (state.attempts + 1), anyApi.weekly_input_cache_admin.refresh, { token: nextToken });
} });
export const refresh = internalAction({ args: { token: v.number() }, handler: async (ctx, { token }) => {
  try {
    const captured = await ctx.runQuery(anyApi.weekly_input_cache_admin.snapshot, { token });
    if (!captured) return { published: false };
    const data = packCacheValue(captured.inputs);
    if (canonicalCacheJson(captured.inputs) !== canonicalCacheJson(unpackCacheValue(data))) throw Error("permanent: weekly codec audit failed");
    const sha256 = await cacheValueDigest(captured.inputs), packed_sha256 = await cacheByteDigest(data);
    return { published: await ctx.runMutation(anyApi.weekly_input_cache_admin.publish, { token, revision: captured.revision, covered_from: captured.inputs.covered_from, data, sha256, packed_sha256 }), bytes: data.byteLength, sha256 };
  } catch (error) {
    await ctx.runMutation(anyApi.weekly_input_cache_admin.failed, { token, error: String(error) });
    return { published: false, error: String(error) };
  }
} });
export const warm = internalMutation({ args: {}, handler: async ctx => {
  const state = await ctx.db.query("weekly_input_cache_state").withIndex("by_key", q => q.eq("key", WEEKLY_INPUT_KEY)).unique();
  if (state?.queued) return { queued: true };
  const token = (state?.job_token ?? 0) + 1;
  if (state) await ctx.db.patch(state._id, { revision: state.revision + 1, ready_revision: undefined, queued: true, job_token: token, attempts: 0, error: undefined });
  else await ctx.db.insert("weekly_input_cache_state", { key: WEEKLY_INPUT_KEY, revision: 0, enabled: false, queued: true, job_token: token, attempts: 0, updated_at: Date.now() });
  await ctx.scheduler.runAfter(0, anyApi.weekly_input_cache_admin.refresh, { token });
  return { queued: true };
} });
export const reset = internalMutation({ args: {}, handler: async ctx => {
  const state = await ctx.db.query("weekly_input_cache_state").withIndex("by_key", q => q.eq("key", WEEKLY_INPUT_KEY)).unique();
  if (state) await ctx.db.patch(state._id, { revision: state.revision + 1, ready_revision: undefined, enabled: false, queued: false, job_token: state.job_token + 1, attempts: 0, updated_at: Date.now() });
  return { sourceReads: true };
} });
export const enable = internalMutation({ args: { revision: v.number(), sha256: v.string() }, handler: async (ctx, args) => {
  const state = await ctx.db.query("weekly_input_cache_state").withIndex("by_key", q => q.eq("key", WEEKLY_INPUT_KEY)).unique();
  const blob = await ctx.db.query("weekly_input_cache_blobs").withIndex("by_key", q => q.eq("key", WEEKLY_INPUT_KEY)).unique();
  if (!state || state.queued || state.revision !== args.revision || state.ready_revision !== args.revision || !blob || blob.revision !== args.revision || blob.sha256 !== args.sha256 || state.covered_from !== blob.covered_from) throw Error("Weekly inputs changed; qualify again");
  await ctx.db.patch(state._id, { enabled: true, updated_at: Date.now() });
  return { enabled: true, revision: args.revision };
} });
export const auditPreparedInputs = internalQuery({ args: {}, handler: async ctx => {
  const cached = await withPreparedWeeklyInputs(ctx, () => loadWeeklyInputSnapshot(ctx));
  if (!cached) throw Error("No prepared weekly inputs");
  const source = { covered_from: cached.covered_from, rows: await sourceWeeklyRows(ctx, cached.covered_from) };
  return { equal: canonicalCacheJson(source) === canonicalCacheJson(cached), source_sha256: await cacheValueDigest(source), count: source.rows.length, covered_from: source.covered_from };
} });
export const preparedRead = internalQuery({ args: { accountSlug: v.union(v.string(), v.null()) }, handler: async (ctx, args) =>
  withPreparedWeeklyInputs(ctx, () => readBundle._handler(ctx, args)) });
export const auditRead = internalQuery({ args: { accountSlug: v.union(v.string(), v.null()) }, handler: async (ctx, args) => {
  const rawCtx = { ...ctx }, cachedCtx = { ...ctx };
  const [source, cached] = await Promise.all([
    withSourceWeeklyInputs(rawCtx, () => readBundle._handler(rawCtx, args)),
    withPreparedWeeklyInputs(cachedCtx, () => readBundle._handler(cachedCtx, args)),
  ]);
  return { equal: canonicalCacheJson(source) === canonicalCacheJson(cached), source_sha256: await cacheValueDigest(source), prepared_sha256: await cacheValueDigest(cached) };
} });
