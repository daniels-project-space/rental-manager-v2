import { sharedStockImplementation } from "./lib/shared_stock_version";
import { computeSharedStock, decodeSharedStock, SHARED_STOCK_KEY, setSharedStockMode } from "./lib/shared_stock_cache";
import { anyApi } from "convex/server";
import { v, type Value } from "convex/values";
import { internalAction, internalMutation, internalQuery, type QueryCtx, type ActionCtx } from "./_generated/server";
import { STOCK_INPUT_KEY, captureStockInputs, loadStockInputCache, withCapturedStockInputs, withPreparedStockInputs, withSourceStockInputs } from "./lib/stock_input_cache";
import { cacheValueDigest, cacheByteDigest, canonicalCacheJson, packCacheValue, unpackCacheValue } from "./lib/lossless_cache_codec";
import { __service_getReplyQueue, __service_getThreadById } from "./replyInbox";
import { __service_sharedStockForStorefront } from "./items";

export const status = internalQuery({ args: {}, handler: async (ctx) => {
  const state = await ctx.db.query("stock_input_cache_state").withIndex("by_key", (q) => q.eq("key", STOCK_INPUT_KEY)).unique();
  const blob = await ctx.db.query("stock_input_cache_blobs").withIndex("by_key", (q) => q.eq("key", STOCK_INPUT_KEY)).unique();
  const shared = await ctx.db.query("stock_shared_snapshot_cache").withIndex("by_key", (q) => q.eq("key", SHARED_STOCK_KEY)).unique();
  return {
    state,
    blob: blob ? { revision: blob.revision, sha256: blob.sha256, packed_sha256: blob.packed_sha256, bytes: blob.data.byteLength } : null,
    shared: shared ? { revision: shared.revision, sha256: shared.sha256, packed_sha256: shared.packed_sha256, bytes: shared.data.byteLength, generated_at: shared.generated_at, enabled: shared.enabled, implementation: shared.implementation } : null,
  };
} });
export const snapshot = internalQuery({ args: { token: v.number() }, handler: async (ctx, { token }) => {
  const state = await ctx.db.query("stock_input_cache_state").withIndex("by_key", (q) => q.eq("key", STOCK_INPUT_KEY)).unique();
  if (!state?.queued || state.job_token !== token) return null;
  const inputs = await captureStockInputs(ctx), implementation = await sharedStockImplementation();
  try {
    return { revision: state.revision, implementation, inputs, shared: await withCapturedStockInputs(ctx, inputs, () => computeSharedStock(ctx)) };
  } catch (error) { return { revision: state.revision, implementation, inputs, shared: null, shared_error: String(error) }; }
} });
export const publish = internalMutation({
  args: { token: v.number(), revision: v.number(), implementation: v.optional(v.string()), data: v.bytes(), sha256: v.string(), packed_sha256: v.string() },
  handler: async (ctx, args) => {
    const state = await ctx.db.query("stock_input_cache_state").withIndex("by_key", (q) => q.eq("key", STOCK_INPUT_KEY)).unique();
    if (!state?.queued || state.job_token !== args.token) return false;
    if (state.revision !== args.revision || args.implementation !== await sharedStockImplementation()) {
      if (state.attempts < 2) {
        const token = state.job_token + 1;
        await ctx.db.patch(state._id, { job_token: token, attempts: state.attempts + 1 });
        await ctx.scheduler.runAfter(1000, anyApi.stock_input_cache_admin.refresh, { token });
      } else await ctx.db.patch(state._id, { enabled: false, queued: false, error: "Source kept changing; source reads remain active" });
      return false;
    }
    const prior = await ctx.db.query("stock_input_cache_blobs").withIndex("by_key", (q) => q.eq("key", STOCK_INPUT_KEY)).unique();
    const { token: _token, implementation: _implementation, ...contents } = args;
    const value = { key: STOCK_INPUT_KEY, version: 1 as const, ...contents };
    if (prior) await ctx.db.replace(prior._id, value); else await ctx.db.insert("stock_input_cache_blobs", value);
    await ctx.db.patch(state._id, { implementation: args.implementation, ready_revision: args.revision, queued: false, attempts: 0, error: undefined, updated_at: Date.now() });
    return true;
  },
});
export const publishSharedSnapshot = internalMutation({
  args: { token: v.number(), revision: v.number(), implementation: v.string(), data: v.bytes(), sha256: v.string(), packed_sha256: v.string(), generated_at: v.number() },
  handler: async (ctx, args) => {
    const state = await ctx.db.query("stock_input_cache_state").withIndex("by_key", q => q.eq("key", STOCK_INPUT_KEY)).unique();
    const implementation = await sharedStockImplementation();
    if (!state || state.job_token !== args.token || state.revision !== args.revision || state.ready_revision !== args.revision || state.implementation !== implementation || args.implementation !== implementation) return false;
    const decoded = await decodeSharedStock(args.data, args.packed_sha256);
    if (await cacheValueDigest(decoded) !== args.sha256) throw Error("permanent: shared stock value hash mismatch");
    const prior = await ctx.db.query("stock_shared_snapshot_cache").withIndex("by_key", q => q.eq("key", SHARED_STOCK_KEY)).unique();
    const { token: _token, ...contents } = args;
    const value = { ...contents, key: SHARED_STOCK_KEY, version: 2 as const, enabled: prior?.enabled ?? false };
    if (prior) await ctx.db.replace(prior._id, value); else await ctx.db.insert("stock_shared_snapshot_cache", value);
    await ctx.db.patch(state._id, { shared_error: undefined, shared_failed_implementation: undefined, shared_failed_revision: undefined });
    return true;
  },
});
export const buildSharedSnapshot = internalQuery({ args: { token: v.number(), revision: v.number() }, handler: async (ctx, args) => {
  const implementation = await sharedStockImplementation();
  const state = await ctx.db.query("stock_input_cache_state").withIndex("by_key", q => q.eq("key", STOCK_INPUT_KEY)).unique();
  if (!state || state.job_token !== args.token || state.revision !== args.revision || state.ready_revision !== args.revision || state.implementation !== implementation) return { implementation, value: null };
  try {
    return { implementation, value: await withPreparedStockInputs(ctx, () => computeSharedStock(ctx)) };
  } catch (error) { return { implementation, value: null, error: String(error) }; }
} });
export const noteSharedFailure = internalMutation({ args: { token: v.number(), revision: v.number(), implementation: v.optional(v.string()), error: v.string() }, handler: async (ctx, args) => {
  const state = await ctx.db.query("stock_input_cache_state").withIndex("by_key", q => q.eq("key", STOCK_INPUT_KEY)).unique();
  const implementation = await sharedStockImplementation();
  if (state?.job_token === args.token && state.revision === args.revision && state.implementation === implementation && (!args.implementation || args.implementation === implementation)) await ctx.db.patch(state._id, { shared_error: args.error.slice(0, 500), shared_failed_implementation: implementation, shared_failed_revision: args.revision });
} });
async function publishComputedShared(ctx: ActionCtx, token: number, revision: number, implementation: string, value: Awaited<ReturnType<typeof computeSharedStock>>) {
  const data = packCacheValue(value);
  if (canonicalCacheJson(value) !== canonicalCacheJson(unpackCacheValue(data))) throw Error("permanent: shared stock codec audit failed");
  return ctx.runMutation(anyApi.stock_input_cache_admin.publishSharedSnapshot, { token, revision, implementation, data, sha256: await cacheValueDigest(value), packed_sha256: await cacheByteDigest(data), generated_at: Date.now() });
}
export const refreshSharedSnapshot = internalAction({ args: { token: v.number(), revision: v.number(), attempt: v.number() }, handler: async (ctx, args) => {
  if (!Number.isInteger(args.attempt) || args.attempt < 0 || args.attempt > 2) throw Error("Invalid shared stock retry count");
  let implementation: string | undefined;
  try {
    const built = await ctx.runQuery(anyApi.stock_input_cache_admin.buildSharedSnapshot, { token: args.token, revision: args.revision });
    if (typeof built.implementation !== "string") throw Error("permanent: invalid shared stock implementation");
    implementation = built.implementation;
    if (built.error) throw Error(built.error);
    if (!built.value) return { published: false };
    return { published: await publishComputedShared(ctx, args.token, args.revision, built.implementation, built.value) };
  } catch (error) {
    await ctx.runMutation(anyApi.stock_input_cache_admin.noteSharedFailure, { token: args.token, revision: args.revision, implementation, error: String(error) });
    if (!String(error).includes("permanent:") && args.attempt < 2) await ctx.scheduler.runAfter(30_000 * (args.attempt + 1), anyApi.stock_input_cache_admin.refreshSharedSnapshot, { ...args, attempt: args.attempt + 1 });
    return { published: false, error: String(error) };
  }
} });
export const failed = internalMutation({ args: { token: v.number(), error: v.string() }, handler: async (ctx, { token, error }) => {
  const state = await ctx.db.query("stock_input_cache_state").withIndex("by_key", (q) => q.eq("key", STOCK_INPUT_KEY)).unique();
  if (!state?.queued || state.job_token !== token) return;
  const retry = !error.includes("permanent:") && state.attempts < 2;
  const nextToken = state.job_token + 1;
  await ctx.db.patch(state._id, { enabled: retry ? state.enabled : false, queued: retry, job_token: nextToken, attempts: state.attempts + 1, error: error.slice(0, 500), updated_at: Date.now() });
  if (retry) await ctx.scheduler.runAfter(30_000 * (state.attempts + 1), anyApi.stock_input_cache_admin.refresh, { token: nextToken });
} });
export const refresh = internalAction({ args: { token: v.number() }, handler: async (ctx, { token }) => {
  try {
    const snapshot = await ctx.runQuery(anyApi.stock_input_cache_admin.snapshot, { token });
    if (!snapshot) return { published: false };
    const data = packCacheValue(snapshot.inputs);
    if (canonicalCacheJson(snapshot.inputs) !== canonicalCacheJson(unpackCacheValue(data))) throw Error("permanent: stock codec audit failed");
    const sha256 = await cacheValueDigest(snapshot.inputs), packed_sha256 = await cacheByteDigest(data);
    const published = await ctx.runMutation(anyApi.stock_input_cache_admin.publish, { token, revision: snapshot.revision, implementation: snapshot.implementation, data, sha256, packed_sha256 });
    let shared: { published: boolean } | null = null;
    if (published) {
      try {
        if (snapshot.shared) shared = { published: await publishComputedShared(ctx, token, snapshot.revision, snapshot.implementation, snapshot.shared) };
        else {
          const error = snapshot.shared_error ?? "Shared stock projection was unavailable";
          await ctx.runMutation(anyApi.stock_input_cache_admin.noteSharedFailure, { token, revision: snapshot.revision, implementation: snapshot.implementation, error });
          if (!error.includes("permanent:")) await ctx.scheduler.runAfter(30_000, anyApi.stock_input_cache_admin.refreshSharedSnapshot, { token, revision: snapshot.revision, attempt: 1 });
        }
      } catch (error) {
        await ctx.runMutation(anyApi.stock_input_cache_admin.noteSharedFailure, { token, revision: snapshot.revision, implementation: snapshot.implementation, error: String(error) });
        if (!String(error).includes("permanent:")) await ctx.scheduler.runAfter(30_000, anyApi.stock_input_cache_admin.refreshSharedSnapshot, { token, revision: snapshot.revision, attempt: 1 });
      }
    }
    return { published, sharedStockPublished: shared?.published ?? false, bytes: data.byteLength, sha256 };
  } catch (error) {
    await ctx.runMutation(anyApi.stock_input_cache_admin.failed, { token, error: String(error) });
    return { published: false, error: String(error) };
  }
} });
export const warm = internalMutation({ args: {}, handler: async (ctx) => {
  const state = await ctx.db.query("stock_input_cache_state").withIndex("by_key", (q) => q.eq("key", STOCK_INPUT_KEY)).unique();
  if (state?.queued) return { queued: true };
  const token = (state?.job_token ?? 0) + 1;
  if (state) await ctx.db.patch(state._id, { revision: state.revision + 1, ready_revision: undefined, queued: true, job_token: token, attempts: 0, error: undefined });
  else await ctx.db.insert("stock_input_cache_state", { key: STOCK_INPUT_KEY, revision: 0, enabled: false, queued: true, job_token: token, attempts: 0, updated_at: Date.now() });
  await ctx.scheduler.runAfter(0, anyApi.stock_input_cache_admin.refresh, { token });
  return { queued: true };
} });
export const reset = internalMutation({ args: {}, handler: async (ctx) => {
  const state = await ctx.db.query("stock_input_cache_state").withIndex("by_key", (q) => q.eq("key", STOCK_INPUT_KEY)).unique();
  if (state) await ctx.db.patch(state._id, { revision: state.revision + 1, ready_revision: undefined, enabled: false, queued: false, job_token: state.job_token + 1, attempts: 0, updated_at: Date.now() });
  return { sourceReads: true };
} });
export const enable = internalMutation({ args: { revision: v.number(), sha256: v.string() }, handler: async (ctx, args) => {
  const state = await ctx.db.query("stock_input_cache_state").withIndex("by_key", (q) => q.eq("key", STOCK_INPUT_KEY)).unique();
  const blob = await ctx.db.query("stock_input_cache_blobs").withIndex("by_key", (q) => q.eq("key", STOCK_INPUT_KEY)).unique();
  if (!state || state.queued || state.revision !== args.revision || state.ready_revision !== args.revision || state.implementation !== await sharedStockImplementation() || !blob || blob.revision !== args.revision || blob.sha256 !== args.sha256) throw Error("Stock inputs changed; qualify again");
  await ctx.db.patch(state._id, { enabled: true, updated_at: Date.now() });
  return { enabled: true, revision: args.revision };
} });
export const auditPreparedInputs = internalQuery({ args: {}, handler: async (ctx) => {
  const preparedCtx = { ...ctx };
  const [source, cached] = await Promise.all([captureStockInputs(ctx), withPreparedStockInputs(preparedCtx, () => loadStockInputCache(preparedCtx))]);
  return { equal: canonicalCacheJson(source) === canonicalCacheJson(cached), source_sha256: await cacheValueDigest(source), counts: Object.fromEntries(Object.entries(source).map(([name, rows]) => [name, rows.length])) };
} });
type ReadHandler = { _handler: (ctx: QueryCtx, args: Record<string, unknown>) => Promise<unknown> };
const readArgs = { kind: v.union(v.literal("thread"), v.literal("queue"), v.literal("storefront")), args: v.any() };
function service(kind: "thread" | "queue" | "storefront"): ReadHandler {
  return (kind === "thread" ? __service_getThreadById : kind === "queue" ? __service_getReplyQueue : __service_sharedStockForStorefront) as unknown as ReadHandler;
}
export const preparedRead = internalQuery({ args: readArgs, handler: async (ctx, request) =>
  withPreparedStockInputs(ctx, () => service(request.kind)._handler(ctx, request.kind === "queue" ? { ...request.args, _bypassMv: true } : request.args)) });
/** Both real handlers run against the same transaction snapshot, with separate
 * request scopes. This also verifies images, prices, grouping and clock outputs. */
export const auditRead = internalQuery({ args: readArgs, handler: async (ctx, request) => {
  const rawCtx = { ...ctx }, cachedCtx = { ...ctx }, args = request.kind === "queue" ? { ...request.args, _bypassMv: true } : request.args;
  const [source, cached] = await Promise.all([
    withSourceStockInputs(rawCtx, () => service(request.kind)._handler(rawCtx, args)),
    withPreparedStockInputs(cachedCtx, () => service(request.kind)._handler(cachedCtx, args)),
  ]);
  return { equal: canonicalCacheJson(source as Value) === canonicalCacheJson(cached as Value), source_sha256: await cacheValueDigest(source as Value), prepared_sha256: await cacheValueDigest(cached as Value), count: Array.isArray(cached) ? cached.length : null };
} });

/** Called once by the Git production build after functions are published. */
export const ensureSharedSnapshot = internalMutation({ args: { expectedDeploymentUrl: v.optional(v.string()) }, handler: async (ctx, args) => {
  if (args.expectedDeploymentUrl && args.expectedDeploymentUrl !== process.env.CONVEX_CLOUD_URL) throw Error("Wrong stock deployment target");
  const state = await ctx.db.query("stock_input_cache_state").withIndex("by_key", q => q.eq("key", STOCK_INPUT_KEY)).unique();
  if (!state?.enabled) return { skipped: "Source cache is disabled" };
  if (state.queued) return { queued: true };
  const implementation = await sharedStockImplementation();
  if (state.shared_failed_revision === state.revision && state.shared_failed_implementation === implementation) return { skipped: "Prior projection failure; source reads remain active" };
  const cached = await ctx.db.query("stock_shared_snapshot_cache").withIndex("by_key", q => q.eq("key", SHARED_STOCK_KEY)).unique();
  if (state.ready_revision === state.revision && state.implementation === implementation && cached?.version === 2 && cached.revision === state.revision && cached.implementation === implementation) {
    try { await decodeSharedStock(cached.data, cached.packed_sha256); return { current: true, enabled: cached.enabled }; } catch { /* Repair derived data only. */ }
  }
  const token = state.job_token + 1;
  await ctx.db.patch(state._id, { queued: true, ready_revision: undefined, job_token: token, attempts: 0, error: undefined });
  await ctx.scheduler.runAfter(0, anyApi.stock_input_cache_admin.refresh, { token });
  return { queued: true };
} });
export const enableShared = internalMutation({ args: { revision: v.number(), sha256: v.string(), implementation: v.string() }, handler: async (ctx, args) => {
  const state = await ctx.db.query("stock_input_cache_state").withIndex("by_key", q => q.eq("key", STOCK_INPUT_KEY)).unique();
  const cached = await ctx.db.query("stock_shared_snapshot_cache").withIndex("by_key", q => q.eq("key", SHARED_STOCK_KEY)).unique();
  if (!state || state.revision !== args.revision || state.ready_revision !== args.revision || state.implementation !== args.implementation || args.implementation !== await sharedStockImplementation() || !cached || cached.version !== 2 || cached.revision !== args.revision || cached.implementation !== args.implementation || cached.sha256 !== args.sha256) throw Error("Shared stock changed; qualify again");
  await decodeSharedStock(cached.data, cached.packed_sha256);
  await ctx.db.patch(cached._id, { enabled: true });
  return { enabled: true, revision: args.revision };
} });
export const disableShared = internalMutation({ args: {}, handler: async ctx => {
  const cached = await ctx.db.query("stock_shared_snapshot_cache").withIndex("by_key", q => q.eq("key", SHARED_STOCK_KEY)).unique();
  if (cached) await ctx.db.patch(cached._id, { enabled: false });
  return { sourceReads: true };
} });
export const readShared = internalQuery({ args: { mode: v.union(v.literal("source"), v.literal("raw"), v.literal("prepared")) }, handler: async (ctx, args) => {
  setSharedStockMode(ctx, args.mode);
  return (__service_sharedStockForStorefront as unknown as ReadHandler)._handler(ctx, {});
} });
