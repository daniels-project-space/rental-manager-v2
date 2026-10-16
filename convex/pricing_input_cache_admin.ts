import { anyApi } from "convex/server";
import { v, type Value } from "convex/values";
import { internalAction, internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { loadPriceIndex, __service_getThreadById, __service_getReplyQueue } from "./replyInbox";
import { getRentalHeadlineStats } from "./dashboard";
import { PRICING_INPUT_KEY, capturePricingInputs, loadPricingSnapshot, withPreparedPricingInputs, withSourcePricingInputs } from "./lib/pricing_input_cache";
import { cacheValueDigest, cacheByteDigest, canonicalCacheJson, packCacheValue, unpackCacheValue } from "./lib/lossless_cache_codec";

export const status = internalQuery({ args: {}, handler: async ctx => {
  const state = await ctx.db.query("pricing_input_cache_state").withIndex("by_key", q => q.eq("key", PRICING_INPUT_KEY)).unique();
  const blob = await ctx.db.query("pricing_input_cache_blobs").withIndex("by_key", q => q.eq("key", PRICING_INPUT_KEY)).unique();
  return { state, blob: blob ? { revision: blob.revision, sha256: blob.sha256, packed_sha256: blob.packed_sha256, bytes: blob.data.byteLength } : null };
} });
export const snapshot = internalQuery({ args: { token: v.number() }, handler: async (ctx, { token }) => {
  const state = await ctx.db.query("pricing_input_cache_state").withIndex("by_key", q => q.eq("key", PRICING_INPUT_KEY)).unique();
  if (!state?.queued || state.job_token !== token) return null;
  return { revision: state.revision, inputs: await capturePricingInputs(ctx) };
} });
export const publish = internalMutation({ args: { token: v.number(), revision: v.number(), data: v.bytes(), sha256: v.string(), packed_sha256: v.string() }, handler: async (ctx, args) => {
  const state = await ctx.db.query("pricing_input_cache_state").withIndex("by_key", q => q.eq("key", PRICING_INPUT_KEY)).unique();
  if (!state?.queued || state.job_token !== args.token) return false;
  if (state.revision !== args.revision) {
    if (state.attempts < 2) {
      const token = state.job_token + 1;
      await ctx.db.patch(state._id, { job_token: token, attempts: state.attempts + 1 });
      await ctx.scheduler.runAfter(30_000 * (state.attempts + 1), anyApi.pricing_input_cache_admin.refresh, { token });
    } else await ctx.db.patch(state._id, { enabled: false, queued: false, error: "Source kept changing; source reads remain active" });
    return false;
  }
  const prior = await ctx.db.query("pricing_input_cache_blobs").withIndex("by_key", q => q.eq("key", PRICING_INPUT_KEY)).unique();
  const { token: _token, ...contents } = args, value = { key: PRICING_INPUT_KEY, version: 1 as const, ...contents };
  if (prior) await ctx.db.replace(prior._id, value); else await ctx.db.insert("pricing_input_cache_blobs", value);
  await ctx.db.patch(state._id, { ready_revision: args.revision, queued: false, attempts: 0, error: undefined, updated_at: Date.now() });
  return true;
} });
export const failed = internalMutation({ args: { token: v.number(), error: v.string() }, handler: async (ctx, { token, error }) => {
  const state = await ctx.db.query("pricing_input_cache_state").withIndex("by_key", q => q.eq("key", PRICING_INPUT_KEY)).unique();
  if (!state?.queued || state.job_token !== token) return;
  const retry = !error.includes("permanent:") && state.attempts < 2, nextToken = state.job_token + 1;
  await ctx.db.patch(state._id, { enabled: retry ? state.enabled : false, queued: retry, job_token: nextToken, attempts: state.attempts + 1, error: error.slice(0, 500), updated_at: Date.now() });
  if (retry) await ctx.scheduler.runAfter(30_000 * (state.attempts + 1), anyApi.pricing_input_cache_admin.refresh, { token: nextToken });
} });
export const refresh = internalAction({ args: { token: v.number() }, handler: async (ctx, { token }) => {
  try {
    const captured = await ctx.runQuery(anyApi.pricing_input_cache_admin.snapshot, { token });
    if (!captured) return { published: false };
    const data = packCacheValue(captured.inputs);
    if (canonicalCacheJson(captured.inputs) !== canonicalCacheJson(unpackCacheValue(data))) throw Error("permanent: pricing codec audit failed");
    const sha256 = await cacheValueDigest(captured.inputs), packed_sha256 = await cacheByteDigest(data);
    return { published: await ctx.runMutation(anyApi.pricing_input_cache_admin.publish, { token, revision: captured.revision, data, sha256, packed_sha256 }), bytes: data.byteLength, sha256 };
  } catch (error) {
    await ctx.runMutation(anyApi.pricing_input_cache_admin.failed, { token, error: String(error) });
    return { published: false, error: String(error) };
  }
} });
export const warm = internalMutation({ args: {}, handler: async ctx => {
  const state = await ctx.db.query("pricing_input_cache_state").withIndex("by_key", q => q.eq("key", PRICING_INPUT_KEY)).unique();
  if (state?.queued) return { queued: true };
  const token = (state?.job_token ?? 0) + 1;
  if (state) await ctx.db.patch(state._id, { revision: state.revision + 1, ready_revision: undefined, queued: true, job_token: token, attempts: 0, error: undefined });
  else await ctx.db.insert("pricing_input_cache_state", { key: PRICING_INPUT_KEY, revision: 0, enabled: false, queued: true, job_token: token, attempts: 0, updated_at: Date.now() });
  await ctx.scheduler.runAfter(0, anyApi.pricing_input_cache_admin.refresh, { token });
  return { queued: true };
} });
export const reset = internalMutation({ args: {}, handler: async ctx => {
  const state = await ctx.db.query("pricing_input_cache_state").withIndex("by_key", q => q.eq("key", PRICING_INPUT_KEY)).unique();
  if (state) await ctx.db.patch(state._id, { revision: state.revision + 1, ready_revision: undefined, enabled: false, queued: false, job_token: state.job_token + 1, attempts: 0, updated_at: Date.now() });
  return { sourceReads: true };
} });
export const enable = internalMutation({ args: { revision: v.number(), sha256: v.string() }, handler: async (ctx, args) => {
  const state = await ctx.db.query("pricing_input_cache_state").withIndex("by_key", q => q.eq("key", PRICING_INPUT_KEY)).unique();
  const blob = await ctx.db.query("pricing_input_cache_blobs").withIndex("by_key", q => q.eq("key", PRICING_INPUT_KEY)).unique();
  if (!state || state.queued || state.revision !== args.revision || state.ready_revision !== args.revision || !blob || blob.revision !== args.revision || blob.sha256 !== args.sha256) throw Error("Pricing inputs changed; qualify again");
  await ctx.db.patch(state._id, { enabled: true, updated_at: Date.now() }); return { enabled: true, revision: args.revision };
} });
export const auditPreparedInputs = internalQuery({ args: {}, handler: async ctx => {
  const [source, cached] = await Promise.all([capturePricingInputs(ctx), withPreparedPricingInputs(ctx, () => loadPricingSnapshot(ctx))]);
  return { equal: canonicalCacheJson(source) === canonicalCacheJson(cached), source_sha256: await cacheValueDigest(source), count: source.length };
} });
export const auditPriceIndex = internalQuery({ args: {}, handler: async ctx => {
  const rawCtx = { ...ctx }, cachedCtx = { ...ctx };
  const [source, cached] = await Promise.all([withSourcePricingInputs(rawCtx, () => loadPriceIndex(rawCtx)), withPreparedPricingInputs(cachedCtx, () => loadPriceIndex(cachedCtx))]);
  return { equal: canonicalCacheJson(source) === canonicalCacheJson(cached), source_sha256: await cacheValueDigest(source), prepared_sha256: await cacheValueDigest(cached), entries: cached.length };
} });
type ReadHandler = { _handler: (ctx: QueryCtx, args: Record<string, unknown>) => Promise<Value> };
export const preparedRead = internalQuery({ args: { kind: v.union(v.literal("thread"), v.literal("queue"), v.literal("headline")), args: v.any() }, handler: async (ctx, request) => {
  const service = (request.kind === "thread" ? __service_getThreadById : request.kind === "queue" ? __service_getReplyQueue : getRentalHeadlineStats) as unknown as ReadHandler;
  return withPreparedPricingInputs(ctx, () => service._handler(ctx, request.kind === "queue" ? { ...request.args, _bypassMv: true } : request.args));
} });
