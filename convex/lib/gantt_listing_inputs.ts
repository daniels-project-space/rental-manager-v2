import type { QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import type { ResolvableRes } from "./reservations/itemUnits";
import { cloneCacheValue } from "./lossless_cache_codec";

const source = new WeakSet<object>();
const reports = new WeakMap<object, { mode: "scoped" | "full"; keys: number | null; reason?: string }>();
export function useSourceGanttInputs(ctx: QueryCtx) { source.add(ctx); }
export function ganttInputReport(ctx: QueryCtx) { return reports.get(ctx); }

/** Image fallbacks also use listing mappings for frozen website bookings.
 * Include their IDs even though physical quantities use the frozen windows. */
export function ganttListingKeys(rows: readonly ResolvableRes[]) {
  const keys = new Map<string, { account: string; productId: number }>();
  for (const row of rows) for (const item of row.hygglo_items ?? []) {
    if (item.product_id == null) continue;
    if (!row.account_slug || !Number.isSafeInteger(item.product_id) || item.product_id === 0) return null;
    const key = `${row.account_slug}#${item.product_id}`;
    keys.set(key, { account: row.account_slug, productId: item.product_id });
    // Larger windows retain the complete original source path, not a clipped
    // subset. This bounds additional point queries to 256 per Gantt execution.
    if (keys.size > 128) return null;
  }
  return [...keys.values()];
}
function ambiguous(rows: Array<{ _creationTime: number }>) {
  const times = new Set<number>();
  return rows.some(row => !Number.isFinite(row._creationTime) || times.has(row._creationTime) || !times.add(row._creationTime));
}
export async function loadGanttListingInputs(ctx: QueryCtx, inventory: Doc<"items">[], rentals: readonly ResolvableRes[]) {
  const keys = ganttListingKeys(rentals);
  const full = async (reason: string) => {
    reports.set(ctx, { mode: "full", keys: keys?.length ?? null, reason });
    // Existing complete-table fallback: 75 index rows / 408 overrides at
    // qualification. Only legacy/large/ambiguous windows or explicit QA use it.
    const [productIndexRows, overrideRows, items] = await Promise.all([
      ctx.db.query("hygglo_product_index").collect(),
      ctx.db.query("listing_resolution_override").collect(),
      // The explicit source mode retains the original second inventory read
      // for a genuine before/after I/O comparison of the existing handler.
      source.has(ctx) ? ctx.db.query("items").collect() : cloneCacheValue(inventory),
    ]);
    return { productIndexRows, overrideRows, inventory: items };
  };
  if (source.has(ctx)) return full("source qualification");
  if (!keys) return full("legacy identity or window exceeds scoped bound");
  const [indexGroups, overrideGroups] = await Promise.all([
    Promise.all(keys.map(key => ctx.db.query("hygglo_product_index").withIndex("by_account_product", q => q.eq("account_slug", key.account).eq("product_id", key.productId)).collect())),
    Promise.all(keys.map(key => ctx.db.query("listing_resolution_override").withIndex("by_account_product", q => q.eq("account_slug", key.account).eq("product_id", key.productId)).collect())),
  ]);
  // Keep the source tie breaker rather than inferring opaque document ordering.
  if ([...indexGroups, ...overrideGroups].some(ambiguous)) return full("source creation-time tie");
  reports.set(ctx, { mode: "scoped", keys: keys.length });
  return { productIndexRows: indexGroups.flat(), overrideRows: overrideGroups.flat(), inventory: cloneCacheValue(inventory) };
}
