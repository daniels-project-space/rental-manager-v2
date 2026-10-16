import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { invalidateStockWhen, patchChangesStockRecord, type StockStaticTable } from "./stock_input_cache";

export async function patchStockInput<T extends StockStaticTable>(ctx: MutationCtx, id: Id<T>, patch: Partial<WithoutSystemFields<Doc<NoInfer<T>>>>) {
  await invalidateStockWhen(ctx, async () => {
    const before = await ctx.db.get(id);
    return before !== null && patchChangesStockRecord(before, patch);
  });
  // Retain the caller's exact table type while bridging Convex's generic
  // PatchValue mapping (the public signature excludes both system fields).
  await ctx.db.patch(id, patch as Partial<Doc<T>>);
}
export async function insertStockInput<T extends StockStaticTable>(ctx: MutationCtx, table: T, value: WithoutSystemFields<Doc<NoInfer<T>>>) {
  await invalidateStockWhen(ctx, () => true);
  return ctx.db.insert(table, value);
}
export async function deleteStockInput<T extends StockStaticTable>(ctx: MutationCtx, id: Id<T>) {
  await invalidateStockWhen(ctx, async () => await ctx.db.get(id) !== null);
  await ctx.db.delete(id);
}
