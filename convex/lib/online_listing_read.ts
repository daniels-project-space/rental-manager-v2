import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { cloneCacheValue } from "./lossless_cache_codec";

// A Convex query has one immutable database snapshot. Share only the exact
// indexed .first() read in that request, including misses and in-flight reads.
const scopes = new WeakMap<object, Map<string, Promise<Doc<"online_listings"> | null>>>();
export async function readOnlineListing(ctx: QueryCtx, account: string, productId: number) {
  let reads = scopes.get(ctx);
  if (!reads) { reads = new Map(); scopes.set(ctx, reads); }
  const key = JSON.stringify([account, productId]);
  let read = reads.get(key);
  if (!read) {
    read = ctx.db.query("online_listings").withIndex("by_account_product", q => q.eq("account_slug", account).eq("product_id", productId)).first();
    reads.set(key, read);
  }
  // Preserve the independent records returned by separate database reads.
  return cloneCacheValue(await read);
}
