import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { invalidateStockWhen, patchChangesStockRecord, type StockStaticTable } from "./stock_input_cache";
import { dirtyInventoryWhen } from "./inventory_read";

export async function patchStockInput<T extends StockStaticTable>(ctx: MutationCtx, id: Id<T>, patch: Partial<WithoutSystemFields<Doc<NoInfer<T>>>>) {
  let beforeRead: Promise<Doc<T> | null> | undefined;
  const changes = async () => {
    const before = await (beforeRead ??= ctx.db.get(id));
    return before !== null && patchChangesStockRecord(before, patch);
  };
  if (ctx.db.normalizeId("items", id) !== null) await dirtyInventoryWhen(ctx, changes);
  await invalidateStockWhen(ctx, changes);
  // Retain the caller's exact table type while bridging Convex's generic
  // PatchValue mapping (the public signature excludes both system fields).
  await ctx.db.patch(id, patch as Partial<Doc<T>>);
}
export async function insertStockInput<T extends StockStaticTable>(ctx: MutationCtx, table: T, value: WithoutSystemFields<Doc<NoInfer<T>>>) {
  if (table === "items") await dirtyInventoryWhen(ctx, () => true);
  await invalidateStockWhen(ctx, () => true);
  return ctx.db.insert(table, value);
}
export async function deleteStockInput<T extends StockStaticTable>(ctx: MutationCtx, id: Id<T>) {
  let beforeRead: Promise<Doc<T> | null> | undefined;
  const changes = async () => await (beforeRead ??= ctx.db.get(id)) !== null;
  if (ctx.db.normalizeId("items", id) !== null) await dirtyInventoryWhen(ctx, changes);
  await invalidateStockWhen(ctx, changes);
  await ctx.db.delete(id);
}
