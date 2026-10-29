import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { cataloguePatchChanges, invalidateCatalogue } from "./catalogue_read_cache";
import { disableProductReadModel, syncProductReadRecord } from "./product_read_model";
import { invalidateStockWhen } from "./stock_input_cache";

export type ProductContext = {
  account_slug: string;
  product_id: number;
  name?: string;
  description?: string;
  master_item_id?: Id<"items">;
  source_last_synced_at: number;
  source_product_id: Id<"hygglo_products">;
  projection_version: 2;
  is_marketing_only?: boolean;
  is_marketing_only_override?: boolean;
  image_urls: string[];
};
export type ProductContextCache = Map<string, Promise<ProductContext | null>>;

export function projectProduct(product: Doc<"hygglo_products">): ProductContext {
  return {
    account_slug: product.accountSlug,
    product_id: product.productId,
    name: product.name,
    description: product.description,
    master_item_id: product.masterItemId,
    source_last_synced_at: product.lastSyncedAt,
    source_product_id: product._id,
    projection_version: 2,
    is_marketing_only: product.isMarketingOnly,
    is_marketing_only_override: product.isMarketingOnlyOverride,
    image_urls: [...new Set((product.images ?? []).slice(0, 6)
      .flatMap((image) => [image.thumbnailUrl, image.fullSizeUrl])
      .filter((url): url is string => typeof url === "string" && !!url))],
  };
}

/** Same-transaction read through, including an exact source fallback during rollout. */
export function loadProductContext(
  ctx: QueryCtx, account: string, productId: number, cache?: ProductContextCache,
): Promise<ProductContext | null> {
  const key = `${account}#${productId}`;
  const existing = cache?.get(key);
  if (existing) return existing;
  const pending = (async () => {
    const row = await ctx.db.query("hygglo_product_context")
      .withIndex("by_account_product", (q) => q.eq("account_slug", account).eq("product_id", productId)).first();
    if (row?.projection_version === 2 && row.source_product_id !== undefined && row.image_urls !== undefined) {
      return { ...row, projection_version: 2 as const, source_product_id: row.source_product_id, image_urls: row.image_urls };
    }
    const source = await ctx.db.query("hygglo_products")
      .withIndex("by_account_product", (q) => q.eq("accountSlug", account).eq("productId", productId)).first();
    return source ? projectProduct(source) : null;
  })();
  cache?.set(key, pending);
  return pending;
}

/** Read the actual oldest source row here, never a potentially stale backfill payload. */
export async function refreshProductContext(
  ctx: MutationCtx, account: string, productId: number,
): Promise<"inserted" | "updated" | "unchanged"> {
  const [source, existingRows] = await Promise.all([
    ctx.db.query("hygglo_products").withIndex("by_account_product", (q) =>
      q.eq("accountSlug", account).eq("productId", productId)).first(),
    ctx.db.query("hygglo_product_context").withIndex("by_account_product", (q) =>
      q.eq("account_slug", account).eq("product_id", productId)).take(101),
  ]);
  if (existingRows.length > 100) throw new Error("Product context mirror exceeded the 100-row repair bound");
  const existing = existingRows[0];
  if (!source) {
    // Remove all old duplicates so deleting a source cannot reveal a stale mirror.
    if (existingRows.length) {
      await invalidateStockWhen(ctx, () => true);
      for (const row of existingRows) await ctx.db.delete(row._id);
      return "updated";
    }
    return "unchanged";
  }
  const next = projectProduct(source);
  if (!existing) {
    await invalidateStockWhen(ctx, () => true);
    await ctx.db.insert("hygglo_product_context", next);
    return "inserted";
  }
  const unchanged = Object.entries(next).every(([key, value]) =>
    JSON.stringify(existing[key as keyof typeof existing]) === JSON.stringify(value));
  const duplicateMirrors = existingRows.slice(1);
  if (unchanged && !duplicateMirrors.length) {
    return "unchanged";
  }
  await invalidateStockWhen(ctx, () => duplicateMirrors.length > 0 || existing.projection_version !== 2 || existing.source_product_id === undefined || existing.image_urls === undefined ||
    ["account_slug", "product_id", "name", "description", "master_item_id"].some(key =>
      existing[key as keyof typeof existing] !== next[key as keyof typeof next]));
  if (!unchanged) await ctx.db.patch(existing._id, next);
  for (const duplicate of duplicateMirrors) await ctx.db.delete(duplicate._id);
  return "updated";
}

/** All source writers go through these helpers; the source and mirror commit atomically.
 * `known`, when supplied, must be a source read from this same mutation transaction. */
export async function patchProduct(
  ctx: MutationCtx, id: Id<"hygglo_products">, patch: Partial<WithoutSystemFields<Doc<"hygglo_products">>>,
  known?: Doc<"hygglo_products">,
) {
  const before = known ?? await ctx.db.get(id);
  if (!before || before._id !== id) throw new Error("Product patch requires its matching source record");
  const previousAccount = before.accountSlug, previousId = before.productId;
  if (cataloguePatchChanges(before, patch)) await invalidateCatalogue(ctx, [previousAccount, patch.accountSlug ?? previousAccount]);
  try {
    await ctx.db.patch(id, patch);
    await refreshProductContext(ctx, previousAccount, previousId);
    const nextAccount = patch.accountSlug ?? previousAccount;
    const nextId = patch.productId ?? previousId;
    if (nextAccount !== previousAccount || nextId !== previousId) {
      await refreshProductContext(ctx, nextAccount, nextId);
    }
    await syncProductReadRecord(ctx, id);
  } catch (error) {
    await invalidateStockWhen(ctx, () => true);
    await disableProductReadModel(ctx);
    throw error;
  }
}

export async function insertProduct(ctx: MutationCtx, value: WithoutSystemFields<Doc<"hygglo_products">>) {
  await invalidateCatalogue(ctx, [value.accountSlug]);
  try {
    const id = await ctx.db.insert("hygglo_products", value);
    await refreshProductContext(ctx, value.accountSlug, value.productId);
    await syncProductReadRecord(ctx, id);
    return id;
  } catch (error) {
    await invalidateStockWhen(ctx, () => true);
    await disableProductReadModel(ctx);
    throw error;
  }
}

export async function deleteProduct(ctx: MutationCtx, id: Id<"hygglo_products">) {
  const before = await ctx.db.get(id);
  if (!before) return;
  await invalidateCatalogue(ctx, [before.accountSlug]);
  try {
    await ctx.db.delete(id);
    await refreshProductContext(ctx, before.accountSlug, before.productId);
    await syncProductReadRecord(ctx, id);
  } catch (error) {
    await invalidateStockWhen(ctx, () => true);
    await disableProductReadModel(ctx);
    throw error;
  }
}
