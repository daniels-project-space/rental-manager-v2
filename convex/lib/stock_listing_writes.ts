import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { invalidateStockWhen, patchChangesStockRecord } from "./stock_input_cache";
import { canonicalCacheJson } from "./lossless_cache_codec";

type Listing = Omit<WithoutSystemFields<Doc<"online_listings">>, "account_slug" | "updated_at">;
/** Canonical allocation reads only the first description for each product.
 * Conflicting duplicate keys conservatively invalidate instead of guessing
 * the creation-time/ID order of newly inserted records. */
export function listingAllocationChanged(before: Array<{ product_id: number; description?: string }>, after: Array<{ product_id: number; description?: string }>) {
  function descriptions(rows: typeof before) {
    const map = new Map<string, string>();
    for (const row of rows) {
      const key = canonicalCacheJson(row.product_id), value = canonicalCacheJson(row.description ?? null);
      if (map.has(key) && map.get(key) !== value) return null;
      map.set(key, value);
    }
    return map;
  }
  const a = descriptions(before), b = descriptions(after);
  return !a || !b || a.size !== b.size || [...a].some(([key, value]) => b.get(key) !== value);
}
export async function patchOnlineListing(ctx: MutationCtx, id: Id<"online_listings">, patch: Partial<WithoutSystemFields<Doc<"online_listings">>>) {
  const physical = Object.fromEntries(Object.entries(patch).filter(([key]) => ["account_slug", "product_id", "description"].includes(key)));
  if (Object.keys(physical).length) await invalidateStockWhen(ctx, async () => {
    const before = await ctx.db.get(id);
    return !!before && patchChangesStockRecord(before, physical);
  });
  await ctx.db.patch(id, patch);
}
export async function replaceOnlineListingRows(ctx: MutationCtx, account: string, listings: Listing[]) {
  const existing = await ctx.db.query("online_listings").withIndex("by_account", q => q.eq("account_slug", account)).collect();
  await invalidateStockWhen(ctx, () => listingAllocationChanged(existing, listings));
  for (const row of existing) await ctx.db.delete(row._id);
  const now = Date.now();
  for (const listing of listings) await ctx.db.insert("online_listings", { ...listing, account_slug: account, updated_at: now });
  return now;
}
