import { anyApi } from "convex/server";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { CATALOGUE_KEY, catalogueProduct, catalogueDigest, packedCatalogueDigest, catalogueProductsEqual, packCatalogue, unpackCatalogue, loadCatalogueProducts } from "./lib/catalogue_read_cache";
import { catalogueForStorefrontRows } from "./hygglo_products";

export const status = internalQuery({ args: {}, handler: async (ctx) => {
  const state = await ctx.db.query("catalogue_cache_state").withIndex("by_key", (q) => q.eq("key", CATALOGUE_KEY)).unique();
  const blob = await ctx.db.query("catalogue_cache_blobs").withIndex("by_key", (q) => q.eq("key", CATALOGUE_KEY)).unique();
  return { state, blob: blob ? { revision: blob.revision, count: blob.count, sha256: blob.sha256, packed_sha256: blob.packed_sha256, bytes: blob.data.byteLength } : null };
} });

/** Known account cardinality: 405 products on 16 Oct 2026; one refresh per substantive batch. */
export const snapshot = internalQuery({ args: { token: v.number() }, handler: async (ctx, { token }) => {
  const state = await ctx.db.query("catalogue_cache_state").withIndex("by_key", (q) => q.eq("key", CATALOGUE_KEY)).unique();
  if (!state?.queued || state.job_token !== token) return null;
  const rows = await ctx.db.query("hygglo_products").withIndex("by_account", (q) => q.eq("accountSlug", "dbcinema")).take(2001);
  if (rows.length > 2000) throw new Error("permanent: catalogue exceeds row bound; use source reads");
  return { revision: state.revision, products: rows.map(catalogueProduct) };
} });

export const publish = internalMutation({
  args: { token: v.number(), revision: v.number(), data: v.bytes(), count: v.number(), sha256: v.string(), packed_sha256: v.string() },
  handler: async (ctx, args) => {
    const state = await ctx.db.query("catalogue_cache_state").withIndex("by_key", (q) => q.eq("key", CATALOGUE_KEY)).unique();
    if (!state?.queued || state.job_token !== args.token) return false;
    if (state.revision !== args.revision) {
      if (state.attempts < 2) {
        const token = state.job_token + 1;
        await ctx.db.patch(state._id, { attempts: state.attempts + 1, job_token: token });
        await ctx.scheduler.runAfter(1000, anyApi.catalogue_cache_admin.refresh, { token });
      } else await ctx.db.patch(state._id, { enabled: false, queued: false, error: "Source kept changing; source reads remain active" });
      return false;
    }
    const prior = await ctx.db.query("catalogue_cache_blobs").withIndex("by_key", (q) => q.eq("key", CATALOGUE_KEY)).unique();
    const { token: _token, ...contents } = args;
    const value = { key: CATALOGUE_KEY, version: 1 as const, ...contents };
    if (prior) await ctx.db.replace(prior._id, value);
    else await ctx.db.insert("catalogue_cache_blobs", value);
    await ctx.db.patch(state._id, { ready_revision: args.revision, queued: false, attempts: 0, error: undefined, updated_at: Date.now() });
    return true;
  },
});

export const failed = internalMutation({ args: { token: v.number(), error: v.string() }, handler: async (ctx, { token, error }) => {
  const state = await ctx.db.query("catalogue_cache_state").withIndex("by_key", (q) => q.eq("key", CATALOGUE_KEY)).unique();
  if (!state?.queued || state.job_token !== token) return;
  const retry = !error.includes("permanent:") && state.attempts < 2;
  const nextToken = state.job_token + 1;
  await ctx.db.patch(state._id, { enabled: retry ? state.enabled : false, queued: retry, job_token: nextToken, attempts: state.attempts + 1, error: error.slice(0, 500), updated_at: Date.now() });
  if (retry) await ctx.scheduler.runAfter(30_000 * (state.attempts + 1), anyApi.catalogue_cache_admin.refresh, { token: nextToken });
} });

export const refresh = internalAction({ args: { token: v.number() }, handler: async (ctx, { token }) => {
  try {
    const snapshot = await ctx.runQuery(anyApi.catalogue_cache_admin.snapshot, { token });
    if (!snapshot) return { published: false };
    const data = packCatalogue(snapshot.products);
    if (!catalogueProductsEqual(snapshot.products, unpackCatalogue(data))) throw new Error("permanent: lossless codec audit failed");
    const sha256 = await catalogueDigest(snapshot.products);
    const packed_sha256 = await packedCatalogueDigest(data);
    const published = await ctx.runMutation(anyApi.catalogue_cache_admin.publish, { token, revision: snapshot.revision, data, sha256, packed_sha256, count: snapshot.products.length });
    return { published, bytes: data.byteLength, count: snapshot.products.length, sha256 };
  } catch (error) {
    await ctx.runMutation(anyApi.catalogue_cache_admin.failed, { token, error: String(error) });
    return { published: false, error: String(error) };
  }
} });

export const warm = internalMutation({ args: {}, handler: async (ctx) => {
  const state = await ctx.db.query("catalogue_cache_state").withIndex("by_key", (q) => q.eq("key", CATALOGUE_KEY)).unique();
  if (state?.queued) return { queued: true };
  const token = (state?.job_token ?? 0) + 1;
  if (state) await ctx.db.patch(state._id, { revision: state.revision + 1, ready_revision: undefined, queued: true, job_token: token, attempts: 0, error: undefined });
  else await ctx.db.insert("catalogue_cache_state", { key: CATALOGUE_KEY, revision: 0, enabled: false, queued: true, job_token: token, attempts: 0, updated_at: Date.now() });
  await ctx.scheduler.runAfter(0, anyApi.catalogue_cache_admin.refresh, { token });
  return { queued: true };
} });

/** Use before rolling back to a backend whose product writers predate this cache. */
export const reset = internalMutation({ args: {}, handler: async (ctx) => {
  const state = await ctx.db.query("catalogue_cache_state").withIndex("by_key", (q) => q.eq("key", CATALOGUE_KEY)).unique();
  if (state) await ctx.db.patch(state._id, { revision: state.revision + 1, ready_revision: undefined, enabled: false, queued: false, job_token: state.job_token + 1, attempts: 0, updated_at: Date.now() });
  return { sourceReads: true };
} });

/** Real computation against a disabled prepared artifact, for operator qualification. */
export const preparedCatalogue = internalQuery({ args: {}, handler: (ctx) => catalogueForStorefrontRows(ctx, true) });
export const auditPreparedInputs = internalQuery({ args: {}, handler: async (ctx) => {
  const [rows, prepared] = await Promise.all([
    ctx.db.query("hygglo_products").withIndex("by_account", (q) => q.eq("accountSlug", "dbcinema")).take(2001),
    loadCatalogueProducts(ctx, true),
  ]);
  if (rows.length > 2000) throw new Error("Catalogue exceeds qualified bound");
  const source = rows.map(catalogueProduct);
  return { equal: catalogueProductsEqual(source, prepared), count: source.length, source_sha256: await catalogueDigest(source) };
} });
export const enable = internalMutation({ args: { revision: v.number(), sha256: v.string() }, handler: async (ctx, args) => {
  const state = await ctx.db.query("catalogue_cache_state").withIndex("by_key", (q) => q.eq("key", CATALOGUE_KEY)).unique();
  const blob = await ctx.db.query("catalogue_cache_blobs").withIndex("by_key", (q) => q.eq("key", CATALOGUE_KEY)).unique();
  if (!state || state.queued || state.revision !== args.revision || state.ready_revision !== args.revision ||
    !blob || blob.revision !== args.revision || blob.sha256 !== args.sha256) throw new Error("Prepared catalogue changed; qualify it again");
  await ctx.db.patch(state._id, { enabled: true, updated_at: Date.now() });
  return { enabled: true, revision: args.revision };
} });
