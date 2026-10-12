import { internalQuery } from "./_generated/server";
import { v } from "convex/values";
import {
  checkOrderRentalStock,
  resolveOrderPhysicalItems,
} from "./lib/renter_order_stock";
/** Internal proposal qualification; only the owner action exposes verified plans. */
import { loadStockSources } from "./lib/renter_stock";

export const check = internalQuery({
  args: {
    account_slug: v.string(),
    thread_id: v.string(),
    start: v.string(),
    end: v.string(),
    include_line_checks: v.optional(v.boolean()),
    lines: v.array(
      v.object({
        name: v.string(),
        qty: v.number(),
        product_id: v.optional(v.number()),
        item_id: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, a) => {
    const sources = await loadStockSources(ctx);
    const result = await checkOrderRentalStock(
      ctx,
      a.account_slug,
      a.lines,
      a.start,
      a.end,
      a.thread_id,
      sources,
    );
    if (!a.include_line_checks) return result;
    if (a.lines.length > 40) return { ...result, line_checks: [] };
    const resolvedLines = await Promise.all(a.lines.map(line=>resolveOrderPhysicalItems(ctx,a.account_slug,[line],sources.items)));
    // A non-rentable/unknown line makes the whole resolver return no receipts.
    // Still qualify the jointly requested known items from the same snapshot.
    const knownLines=a.lines.filter((_,index)=>resolvedLines[index].items.length>0);
    const knownResult=knownLines.length && knownLines.length!==a.lines.length
      ? await checkOrderRentalStock(ctx,a.account_slug,knownLines,a.start,a.end,a.thread_id,sources) : result;
    const line_checks = [];
    for (const [item_index] of a.lines.entries()) {
      const resolved=resolvedLines[item_index];
      const receipts = resolved.items.map((item) =>
        knownResult.receipts.find(
          (receipt) => String(receipt.item_id) === item.item_id,
        ),
      );
      const available = !resolved.items.length
        ? resolved.available === false
          ? false
          : null
        : receipts.some((receipt) => !receipt || receipt.available == null)
          ? null
          : receipts.some((receipt) => receipt!.available === false)
            ? false
            : true;
      line_checks.push({ item_index, available });
    }
    return { ...result, line_checks };
  },
});
