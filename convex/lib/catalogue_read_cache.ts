import { anyApi } from "convex/server";
import { convexToJson, jsonToConvex } from "convex/values";
import { gzipSync, gunzipSync, strFromU8, strToU8 } from "fflate";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export const CATALOGUE_KEY = "dbcinema:v1" as const;
// Bump the cache key/version when changing this payload contract.
const fields = ["productId", "name", "isPublished", "isMarketingOnly", "isMarketingOnlyOverride", "marketingOnlyUpdatedAt",
  "valuation", "minimumRentalDays", "prices", "images", "unavailableDates", "listings", "masterItemId", "description"] as const;
export type CatalogueProduct = Pick<Doc<"hygglo_products">, typeof fields[number]>;

export function catalogueProduct(source: Pick<Doc<"hygglo_products">, typeof fields[number]>): CatalogueProduct {
  return Object.fromEntries(fields.filter((key) => source[key] !== undefined).map((key) => [key, source[key]])) as CatalogueProduct;
}
export function catalogueProductsEqual(a: CatalogueProduct[], b: CatalogueProduct[]) {
  return JSON.stringify(convexToJson(a)) === JSON.stringify(convexToJson(b));
}
export async function catalogueDigest(products: CatalogueProduct[]) {
  const bytes = strToU8(JSON.stringify(convexToJson(products)));
  return packedCatalogueDigest(Uint8Array.from(bytes).buffer);
}
export async function packedCatalogueDigest(data: ArrayBuffer) {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function packCatalogue(products: CatalogueProduct[]): ArrayBuffer {
  const raw = strToU8(JSON.stringify(convexToJson(products)));
  if (raw.byteLength > 8 * 1024 * 1024) throw new Error("permanent: catalogue exceeds cache input bound; use source reads");
  const packed = gzipSync(raw, { level: 6, mtime: 0 });
  if (packed.byteLength > 800_000) throw new Error("permanent: catalogue exceeds cache row bound; use source reads");
  return Uint8Array.from(packed).buffer;
}
export function unpackCatalogue(data: ArrayBuffer): CatalogueProduct[] {
  if (data.byteLength < 18 || new DataView(data).getUint32(data.byteLength - 4, true) > 8 * 1024 * 1024) throw new Error("Invalid catalogue cache size");
  const value = jsonToConvex(JSON.parse(strFromU8(gunzipSync(new Uint8Array(data)))));
  if (!Array.isArray(value)) throw new Error("Invalid catalogue cache");
  return value as CatalogueProduct[];
}

// A single queue per mutation also protects batches using Promise.all.
const queues = new WeakMap<object, Promise<unknown>>();
export function invalidateCatalogue(ctx: MutationCtx, accounts: string[]): Promise<void> {
  if (!accounts.includes("dbcinema")) return Promise.resolve();
  const prior = queues.get(ctx) ?? Promise.resolve();
  const next = prior.then(async () => {
    const state = await ctx.db.query("catalogue_cache_state").withIndex("by_key", (q) => q.eq("key", CATALOGUE_KEY)).unique();
    const revision = (state?.revision ?? 0) + 1;
    if (state) await ctx.db.patch(state._id, { revision, updated_at: Date.now() });
    else await ctx.db.insert("catalogue_cache_state", { key: CATALOGUE_KEY, revision, enabled: false, queued: false, job_token: 0, attempts: 0, updated_at: Date.now() });
    if (state?.enabled && !state.queued) {
      const current = await ctx.db.query("catalogue_cache_state").withIndex("by_key", (q) => q.eq("key", CATALOGUE_KEY)).unique();
      const token = current!.job_token + 1;
      await ctx.db.patch(current!._id, { queued: true, job_token: token, attempts: 0, error: undefined });
      await ctx.scheduler.runAfter(0, anyApi.catalogue_cache_admin.refresh, { token });
    }
  });
  queues.set(ctx, next);
  return next;
}

export function cataloguePatchChanges(before: Doc<"hygglo_products">, patch: Partial<Doc<"hygglo_products">>) {
  if (before.accountSlug !== "dbcinema" && patch.accountSlug !== "dbcinema") return false;
  if (patch.accountSlug !== undefined && patch.accountSlug !== before.accountSlug) return true;
  if (!fields.some((key) => Object.prototype.hasOwnProperty.call(patch, key))) return false;
  const after = { ...before, ...patch };
  return !catalogueProductsEqual([catalogueProduct(before)], [catalogueProduct(after)]);
}

/** Dirty/missing/unsupported data always takes the original indexed source path. */
export async function loadCatalogueProducts(ctx: QueryCtx, allowPrepared = false): Promise<CatalogueProduct[]> {
  const source = async () => (await ctx.db.query("hygglo_products")
    .withIndex("by_account", (q) => q.eq("accountSlug", "dbcinema")).collect()).map(catalogueProduct);
  try {
    const state = await ctx.db.query("catalogue_cache_state").withIndex("by_key", (q) => q.eq("key", CATALOGUE_KEY)).unique();
    if (!state || (!state.enabled && !allowPrepared) || state.ready_revision !== state.revision) {
      if (allowPrepared) throw new Error("Prepared catalogue is not current");
      return source();
    }
    const blob = await ctx.db.query("catalogue_cache_blobs").withIndex("by_key", (q) => q.eq("key", CATALOGUE_KEY)).unique();
    if (!blob || blob.revision !== state.revision || blob.version !== 1) throw new Error("Catalogue cache version mismatch");
    if (await packedCatalogueDigest(blob.data) !== blob.packed_sha256) throw new Error("Catalogue cache hash mismatch");
    const products = unpackCatalogue(blob.data);
    if (products.length === blob.count) return products;
  } catch (error) {
    if (allowPrepared) throw error;
    // Preserve service output if a derived artifact is damaged.
  }
  if (allowPrepared) throw new Error("Prepared catalogue count mismatch");
  return source();
}
