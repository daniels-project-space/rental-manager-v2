import type { QueryCtx } from "../_generated/server";
import { loadListingInventory } from "./listing_inventory";
import { loadStockSources, stockForItem } from "./renter_stock";

type Line = { name: string; qty: number; item_id?: string; product_id?: number };
/** Check the candidate basket in the mutation's database snapshot. Shared kit
 * components are counted together; independent per-line successes are unsafe. */
export async function checkOrderRentalStock(ctx: QueryCtx, account: string, lines: Line[], start: string, end: string, thread: string) {
  const sources = await loadStockSources(ctx);
  const required = new Map<string, number>();
  for (const line of lines) {
    if (!Number.isInteger(line.qty) || line.qty < 1 || line.qty > 20) return { available: null, reason: "invalid_quantity", receipts: [] };
    if (line.product_id != null) {
      const listing = await loadListingInventory(ctx, account, line.product_id, line.qty, sources);
      if (!listing.complete || listing.owned !== true) return { available: listing.owned === false ? false : null, reason: "listing_not_rentable_or_unmapped", receipts: [] };
      for (const c of listing.components.filter(c => c.stock_required)) required.set(c.item_id, (required.get(c.item_id) ?? 0) + c.requested_units);
    } else {
      const matches = sources.items.filter(i => line.item_id ? String(i._id) === line.item_id : i.name_canonical.toLowerCase() === line.name.toLowerCase());
      if (matches.length !== 1) return { available: null, reason: "unresolved_order_item", receipts: [] };
      const id = String(matches[0]._id);
      required.set(id, (required.get(id) ?? 0) + line.qty);
    }
  }
  if (!required.size) return { available: null, reason: "no_physical_order_items", receipts: [] };
  const receipts = [...required].map(([id, quantity]) => {
    const item = sources.items.find(i => String(i._id) === id)!;
    return { ...stockForItem(sources, item, { item_name: item.name_canonical, start_date: start, end_date: end, quantity, thread_id: thread }), start_date: start, end_date: end };
  });
  const available = receipts.some(r => r.available === false) ? false : receipts.every(r => r.available === true) ? true : null;
  return { available, reason: available === true ? "available" : available === false ? "component_unavailable" : "stock_unknown", receipts };
}
