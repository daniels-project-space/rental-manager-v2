import { anyApi } from "convex/server";
import { declaredMarketingListingKeys, marketingOnlyRequestIds } from "./marketing_only_requests";
import { buildOverrideMap, buildProductIndexMap } from "./reservations/itemUnits";
import type { MessageLite, ReservationLite } from "./conversation_funnel";
import type { Doc } from "../_generated/dataModel";

export const FUNNEL_SOURCE_FIELDS = {
  hygglo_messages: ["thread_id", "account_slug", "sender", "hygglo_sent_at", "fetched_at"],
  reservations: ["hygglo_order_id", "account_slug", "status", "hygglo_system_signal", "net_to_owner_gbp", "items", "hygglo_items", "resolved_items", "expanded_items"],
  items: ["_id", "name_canonical", "aliases", "kind", "status", "qty", "is_marketing_only", "lens_mount", "track_independent_stock"],
  hygglo_product_index: ["account_slug", "product_id", "item_id"],
  listing_resolution_override: ["account_slug", "product_id", "components"],
  online_listings: ["account_slug", "product_id", "description"],
} as const;
export type FunnelSource = keyof typeof FUNNEL_SOURCE_FIELDS;
export function projectFunnelSource(table: FunnelSource, row: Record<string, unknown>) {
  return Object.fromEntries(FUNNEL_SOURCE_FIELDS[table].filter(key => row[key] !== undefined).map(key => [key, row[key]]));
}

/** Whole history, compact payloads and bounded Native transactions. No truncation. */
export async function loadPagedFunnelSources(ctx: {runQuery: (fn: typeof anyApi.funnel_sources.readPage, args: Record<string, unknown>) => Promise<{page:Record<string,unknown>[];isDone:boolean;continueCursor:string}>}, asOf: number) {
  const tables = Object.keys(FUNNEL_SOURCE_FIELDS) as FunnelSource[];
  const results = await Promise.all(tables.map(async table => {
    const rows: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    let pages = 0;
    while (true) {
      const result = await ctx.runQuery(anyApi.funnel_sources.readPage, {table, asOf, paginationOpts:{cursor,numItems:250}});
      rows.push(...result.page);pages++;
      if (result.isDone) return {table,rows,pages};
      if (result.continueCursor === cursor) throw new Error("Funnel pagination did not advance");
      cursor = result.continueCursor;
    }
  }));
  const data = Object.fromEntries(results.map(r => [r.table,r.rows]));
  const reservations = data.reservations as Array<ReservationLite & Pick<Doc<"reservations">,"hygglo_items"|"resolved_items"|"expanded_items"|"items">>;
  const items = data.items as Doc<"items">[];
  const requested = new Set(reservations.flatMap(r => (r.hygglo_items ?? []).filter(i => i.product_id !== undefined).map(i => `${r.account_slug ?? ""}#${i.product_id}`)));
  const listings = (data.online_listings as Doc<"online_listings">[]).filter(l => requested.has(`${l.account_slug}#${l.product_id}`));
  const marketing = marketingOnlyRequestIds(reservations,items,buildProductIndexMap(data.hygglo_product_index as Doc<"hygglo_product_index">[]),buildOverrideMap(data.listing_resolution_override as Doc<"listing_resolution_override">[]),declaredMarketingListingKeys(listings,items));
  return {messages:data.hygglo_messages as MessageLite[],reservations,marketingOnlyRequestIds:marketing,counts:Object.fromEntries(results.map(r => [r.table,{rows:r.rows.length,pages:r.pages}]))};
}
