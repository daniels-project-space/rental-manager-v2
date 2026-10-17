import type { QueryCtx } from "../_generated/server";
import { sharedStockSnapshot } from "./storefront_stock";
import { loadStockSources } from "./renter_stock";
import { loadStockInputCacheState, withSourceStockInputs } from "./stock_input_cache";
import { cacheByteDigest, unpackCacheValue } from "./lossless_cache_codec";
import { sharedStockImplementation } from "./shared_stock_version";

export const SHARED_STOCK_KEY = "shared-stock:v2" as const;
export type SharedStock = ReturnType<typeof sharedStockSnapshot>;
const modes = new WeakMap<object, "source" | "raw" | "prepared">();
export function setSharedStockMode(ctx: QueryCtx, mode: "source" | "raw" | "prepared") { modes.set(ctx, mode); }
export const computeSharedStock = async (ctx: QueryCtx) => sharedStockSnapshot(await loadStockSources(ctx), Date.now());
export async function decodeSharedStock(data: ArrayBuffer, packedHash: string): Promise<SharedStock> {
  if (await cacheByteDigest(data) !== packedHash) throw Error("Shared stock cache hash mismatch");
  const value = unpackCacheValue(data) as unknown as SharedStock;
  if (!value || value.version !== 2 || !Array.isArray(value.units) || typeof value.checkedAt !== "number" || typeof value.turnaroundBufferMinutes !== "number") throw Error("Invalid shared stock payload");
  return value;
}
export async function readSharedStock(ctx: QueryCtx): Promise<SharedStock> {
  const mode = modes.get(ctx);
  if (mode === "raw") return withSourceStockInputs(ctx, () => computeSharedStock(ctx));
  if (mode === "source") return computeSharedStock(ctx);
  let value: SharedStock | undefined;
  try {
    const implementation = await sharedStockImplementation();
    const state = await loadStockInputCacheState(ctx);
    if (!state?.enabled || state.ready_revision !== state.revision || state.implementation !== implementation) throw Error("Shared stock inputs are not current");
    const cached = await ctx.db.query("stock_shared_snapshot_cache").withIndex("by_key", q => q.eq("key", SHARED_STOCK_KEY)).unique();
    if (!cached || cached.version !== 2 || cached.implementation !== implementation || cached.revision !== state.revision || !cached.enabled && mode !== "prepared") throw Error("Shared stock projection is not current");
    value = await decodeSharedStock(cached.data, cached.packed_sha256);
  } catch (error) {
    if (mode === "prepared") throw error;
    return computeSharedStock(ctx);
  }
  // Keep freshness failures outside the artifact fallback catch. Holds are
  // deliberately excluded from this projection, but freshness remains live.
  if (process.env.REQUIRE_WEBSITE_STOCK_HOLDS_SYNC === "true") {
    const checkout = await ctx.db.query("storefront_checkout_stock").withIndex("by_key", q => q.eq("key", "website")).first();
    if (!checkout || Date.now() - checkout.receivedAt > 180_000) throw Error("Website checkout stock snapshot needs refresh; availability cannot be confirmed.");
  }
  return { ...value, checkedAt: Date.now() };
}
