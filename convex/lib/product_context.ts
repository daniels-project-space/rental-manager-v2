import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

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
  const [source, existing] = await Promise.all([
    ctx.db.query("hygglo_products").withIndex("by_account_product", (q) =>
      q.eq("accountSlug", account).eq("productId", productId)).first(),
    ctx.db.query("hygglo_product_context").withIndex("by_account_product", (q) =>
      q.eq("account_slug", account).eq("product_id", productId)).first(),
  ]);
  if (!source) {
    // Remove all old duplicates so deleting a source cannot reveal a stale mirror.
    if (existing) {
      const rows = await ctx.db.query("hygglo_product_context").withIndex("by_account_product", (q) =>
        q.eq("account_slug", account).eq("product_id", productId)).collect();
      for (const row of rows) await ctx.db.delete(row._id);
      return "updated";
    }
    return "unchanged";
  }
  const next = projectProduct(source);
  if (!existing) {
    await ctx.db.insert("hygglo_product_context", next);
    return "inserted";
  }
  if (Object.entries(next).every(([key, value]) => JSON.stringify(existing[key as keyof typeof existing]) === JSON.stringify(value))) {
    return "unchanged";
  }
  await ctx.db.patch(existing._id, next);
  return "updated";
}

/** All source writers go through these helpers; the source and mirror commit atomically. */
export async function patchProduct(
  ctx: MutationCtx, id: Id<"hygglo_products">, patch: Partial<WithoutSystemFields<Doc<"hygglo_products">>>,
  known?: Doc<"hygglo_products">,
) {
  const before = known ?? await ctx.db.get(id);
  if (!before || before._id !== id) throw new Error("Product patch requires its matching source record");
  const previousAccount = before.accountSlug, previousId = before.productId;
  await ctx.db.patch(id, patch);
  await refreshProductContext(ctx, previousAccount, previousId);
  const nextAccount = patch.accountSlug ?? previousAccount;
  const nextId = patch.productId ?? previousId;
  if (nextAccount !== previousAccount || nextId !== previousId) {
    await refreshProductContext(ctx, nextAccount, nextId);
  }
}

export async function insertProduct(ctx: MutationCtx, value: WithoutSystemFields<Doc<"hygglo_products">>) {
  const id = await ctx.db.insert("hygglo_products", value);
  await refreshProductContext(ctx, value.accountSlug, value.productId);
  return id;
}

export async function deleteProduct(ctx: MutationCtx, id: Id<"hygglo_products">) {
  const before = await ctx.db.get(id);
  if (!before) return;
  await ctx.db.delete(id);
  await refreshProductContext(ctx, before.accountSlug, before.productId);
}
