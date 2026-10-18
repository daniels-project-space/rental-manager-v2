import { loadPricingRows, patchPricingInput, insertPricingInput } from "./lib/pricing_input_cache";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./owner_functions";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

/**
 * Queue an owner-approved price recommendation for the exact Hygglo listing
 * mapped to this account's inventory item. Catalog prices change only after
 * the worker confirms the live listing update.
 */
export const applyRecommendation = mutation({
  args: {
    pricingRowId: v.id("pricing_catalog"),
    accountSlug: v.string(),
    itemNameCanonical: v.string(),
    newDailyRate: v.number(),
    demandSignature: v.string(),
  },
  handler: async (ctx, { pricingRowId, accountSlug, itemNameCanonical, newDailyRate, demandSignature }) => {
    if (!Number.isFinite(newDailyRate) || newDailyRate <= 0) throw new Error("newDailyRate must be a positive finite number");
    if (demandSignature.length > 4000) throw new Error("Recommendation signature is too large; refresh the list");
    if (process.env.ALLOW_RECOMMENDATION_PRICE_WRITES !== "true") {
      throw new Error("Hygglo recommendation price updates are disabled");
    }
    const row = await ctx.db.get(pricingRowId);
    if (!row || row.item_name_canonical !== itemNameCanonical) throw new Error("Recommendation no longer matches this pricing row");
    const account = await ctx.db.query("accounts").withIndex("by_slug", q => q.eq("slug", accountSlug)).unique();
    if (!account || row.account_id !== account._id) throw new Error("Pricing row belongs to a different account");
    if (!row.item_id || row.is_bundle || row.marketing_only) {
      throw new Error("This recommendation is not linked to a single inventory item");
    }
    const demandCount = demandSignature ? demandSignature.split(",").filter(Boolean).length : 0;
    const expectedRate = demandCount >= 3
      ? Number((row.daily_price_min * 1.15).toFixed(2))
      : demandCount <= 1
        ? Number((row.daily_price_min * 0.9).toFixed(2))
        : null;
    if (expectedRate === null || Math.abs(expectedRate - newDailyRate) > 0.005) {
      throw new Error("Recommendation changed; refresh the list and try again");
    }

    // Resolve only through the deterministic account+product mapping. Never
    // infer the marketplace listing from a similar title or fuzzy catalog link.
    const mappings = await ctx.db.query("hygglo_product_index")
      .withIndex("by_item_id", q => q.eq("item_id", row.item_id!))
      .take(101);
    const overrides = await ctx.db.query("listing_resolution_override")
      .withIndex("by_stock_item", q => q.eq("stock_item_id", row.item_id!))
      .take(101);
    const productIds = [...new Set([
      ...mappings.filter(mapping => mapping.account_slug === accountSlug).map(mapping => mapping.product_id),
      ...overrides
        .filter(mapping => mapping.account_slug === accountSlug && mapping.components.length === 1 && mapping.components[0].item_id === row.item_id && mapping.components[0].qty === 1)
        .map(mapping => mapping.product_id),
    ])];
    if (mappings.length > 100 || overrides.length > 100 || productIds.length !== 1) {
      throw new Error(productIds.length === 0
        ? "No exact Hygglo listing is mapped to this item on this account"
        : "More than one Hygglo listing maps to this item; update the listing mapping before applying");
    }

    const previous = await ctx.db.query("recommendation_price_apply_jobs")
      .withIndex("by_pricing_demand_created", q => q.eq("pricing_row_id", row._id).eq("demand_signature", demandSignature))
      .order("desc")
      .first();
    if (previous && previous.status !== "failed") {
      return { ok: previous.status === "succeeded", jobId: previous._id, status: previous.status, newDailyRate };
    }

    const now = Date.now();
    const jobId = await ctx.db.insert("recommendation_price_apply_jobs", {
      account_slug: accountSlug,
      pricing_row_id: row._id,
      item_id: row.item_id,
      product_id: productIds[0],
      item_name_canonical: itemNameCanonical,
      old_price: row.daily_price_min,
      new_price: newDailyRate,
      demand_signature: demandSignature,
      status: "queued",
      created_at: now,
      updated_at: now,
    });
    await ctx.scheduler.runAfter(0, internal.pricing_catalog.publishRecommendationPrice, { jobId });
    return { ok: true, jobId, status: "queued", newDailyRate };
  },
});

/** Small, indexed status feed for the recommendation widget. */
export const getRecommendationPriceApplyJobs = query({
  args: { accountSlug: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { accountSlug }) => {
    if (accountSlug) return ctx.db.query("recommendation_price_apply_jobs")
      .withIndex("by_account_updated", q => q.eq("account_slug", accountSlug))
      .order("desc")
      .take(100);
    const perAccount = await Promise.all(["leo", "dbcinema", "diogo"].map(slug =>
      ctx.db.query("recommendation_price_apply_jobs")
        .withIndex("by_account_updated", q => q.eq("account_slug", slug))
        .order("desc")
        .take(100),
    ));
    return perAccount.flat().sort((a, b) => b.updated_at - a.updated_at).slice(0, 100);
  },
});

export const getRecommendationPriceApplyJob = internalQuery({
  args: { jobId: v.id("recommendation_price_apply_jobs") },
  handler: async (ctx, { jobId }) => ctx.db.get(jobId),
});

export const markRecommendationPriceApplyProcessing = internalMutation({
  args: { jobId: v.id("recommendation_price_apply_jobs") },
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.get(jobId);
    if (!job || job.status === "succeeded" || job.status === "failed") return null;
    await ctx.db.patch(jobId, { status: "processing", updated_at: Date.now() });
    return job;
  },
});

export const finishRecommendationPriceApply = internalMutation({
  args: { jobId: v.id("recommendation_price_apply_jobs"), success: v.boolean(), error: v.optional(v.string()) },
  handler: async (ctx, { jobId, success, error }) => {
    const job = await ctx.db.get(jobId);
    if (!job || job.status === "succeeded" || job.status === "failed") return null;
    const now = Date.now();
    await ctx.db.patch(jobId, {
      status: success ? "succeeded" : "failed",
      updated_at: now,
      finished_at: now,
      error: success ? undefined : (error ?? "Hygglo price update failed").slice(0, 500),
    });
    await ctx.db.insert("price_change_audit", {
      account_slug: job.account_slug,
      listing_id: job.product_id,
      old_price: job.old_price,
      new_price: job.new_price,
      changed_at: now,
      source: "price_recommendation",
      success,
      error: success ? undefined : (error ?? "Hygglo price update failed").slice(0, 500),
    });
    if (success) {
      const row = await ctx.db.get(job.pricing_row_id);
      if (row && row.item_id === job.item_id && row.account_id) {
        await patchPricingInput(ctx, row._id, {
          daily_price_min: job.new_price,
          daily_price_max: Math.max(row.daily_price_max, job.new_price),
        }, row);
        await recordRecommendationDismissal(ctx, row._id, job.account_slug, job.item_name_canonical, job.demand_signature, "applied");
      }
    }
    return { ok: success };
  },
});

/** Durable worker: live-read, drift-check, edit one listing, then read back. */
export const publishRecommendationPrice = internalAction({
  args: { jobId: v.id("recommendation_price_apply_jobs") },
  handler: async (ctx, { jobId }): Promise<{ ok: boolean; productId?: number; error?: string }> => {
    const job: Doc<"recommendation_price_apply_jobs"> | null = await ctx.runQuery(internal.pricing_catalog.getRecommendationPriceApplyJob, { jobId });
    if (!job || job.status === "succeeded" || job.status === "failed") return { ok: job?.status === "succeeded" };
    if (process.env.ALLOW_RECOMMENDATION_PRICE_WRITES !== "true") {
      await ctx.runMutation(internal.pricing_catalog.finishRecommendationPriceApply, {
        jobId, success: false, error: "Hygglo recommendation price updates are disabled",
      });
      return { ok: false };
    }
    await ctx.runMutation(internal.pricing_catalog.markRecommendationPriceApplyProcessing, { jobId });
    const base = (process.env.NOTIF_BASE_URL ?? "https://rental-manager-v2-nu.vercel.app").replace(/\/$/, "");
    const url = `${base}/api/listings/${encodeURIComponent(job.account_slug)}/item/${encodeURIComponent(String(job.product_id))}`;
    try {
      const getListing = async () => {
        const response = await fetch(url, { method: "GET" });
        if (!response.ok) throw new Error(`Hygglo listing read failed (${response.status})`);
        return await response.json() as { prices?: Array<{ days?: number; pricePerDay?: number; price?: number }> };
      };
      const live = await getListing();
      const prices = live.prices ?? [];
      const daily = prices.filter(price => price.days === 1);
      if (daily.length !== 1) throw new Error("Live listing does not have exactly one one-day price tier");
      const currentPrice = daily[0].pricePerDay ?? daily[0].price;
      if (typeof currentPrice !== "number" || !Number.isFinite(currentPrice) || currentPrice <= 0) {
        throw new Error("Live listing has no usable one-day price");
      }
      if (Math.abs(currentPrice - job.new_price) > 0.01) {
        if (Math.abs(currentPrice - job.old_price) > 0.01) {
          throw new Error(`Price changed since this recommendation was shown (expected £${job.old_price}, live is £${currentPrice})`);
        }
        const nextPrices = prices.map(price => price.days === 1
          ? { ...price, pricePerDay: job.new_price, price: job.new_price }
          : price);
        const response = await fetch(url, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prices: nextPrices }),
        });
        if (!response.ok) throw new Error(`Hygglo listing update failed (${response.status})`);
        const result = await response.json() as { ok?: boolean; error?: string };
        if (result.ok !== true) throw new Error(result.error ?? "Hygglo rejected the price update");
      }
      const verified = await getListing();
      const confirmed = (verified.prices ?? []).filter(price => price.days === 1);
      const confirmedPrice = confirmed.length === 1 ? confirmed[0].pricePerDay ?? confirmed[0].price : undefined;
      if (typeof confirmedPrice !== "number" || Math.abs(confirmedPrice - job.new_price) > 0.01) {
        throw new Error("Hygglo accepted the update but read-back did not confirm the recommended price");
      }
      await ctx.runMutation(internal.pricing_catalog.finishRecommendationPriceApply, { jobId, success: true });
      return { ok: true, productId: job.product_id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.runMutation(internal.pricing_catalog.finishRecommendationPriceApply, { jobId, success: false, error: message });
      return { ok: false, error: message };
    }
  },
});

/**
 * W17 Price Recommendations — dismiss a recommendation.
 * Stores a dismissal record so the item is hidden from the recommendations list.
 */
export const dismissRecommendation = mutation({
  args: {
    pricingRowId: v.id("pricing_catalog"),
    accountSlug: v.string(),
    itemNameCanonical: v.string(),
    demandSignature: v.string(),
  },
  handler: async (ctx, { pricingRowId, accountSlug, itemNameCanonical, demandSignature }) => {
    const row = await ctx.db.get(pricingRowId);
    if (!row || row.item_name_canonical !== itemNameCanonical) throw new Error("Recommendation no longer matches this pricing row");
    const account = await ctx.db.query("accounts").withIndex("by_slug", q => q.eq("slug", accountSlug)).unique();
    if (!account || row.account_id !== account._id) throw new Error("Pricing row belongs to a different account");
    await recordRecommendationDismissal(ctx, row._id, accountSlug, itemNameCanonical, demandSignature, "user");
    return { ok: true, already_dismissed: false };
  },
});

async function recordRecommendationDismissal(
  ctx: MutationCtx,
  pricingRowId: Id<"pricing_catalog">,
  accountSlug: string,
  itemNameCanonical: string,
  demandSignature: string,
  dismissedBy: "user" | "applied",
) {
  const existing = await ctx.db.query("recommendation_dismissals")
    .withIndex("by_pricing_row", (q) => q.eq("pricing_row_id", pricingRowId)).first();
  const value = {
    pricing_row_id: pricingRowId,
    account_slug: accountSlug,
    item_name_canonical: itemNameCanonical,
    demand_signature: demandSignature,
    dismissed_at: Date.now(),
    dismissed_by: dismissedBy,
  };
  if (existing) await ctx.db.patch(existing._id, value);
  else await ctx.db.insert("recommendation_dismissals", value);
}

/**
 * Query dismissed item names (used by W17 to filter recommendations list).
 */
export const getDismissedItemNames = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("recommendation_dismissals").collect();
    return rows.map((r) => r.item_name_canonical);
  },
});

/**
 * Seed / upsert a single pricing_catalog row (used by seed-pricing-from-v1.mjs).
 * Matches on item_name_canonical; inserts if missing, patches rates if present.
 */
export const upsertPricingRow = mutation({
  args: {
    item_name_canonical: v.string(),
    daily_price_min: v.number(),
    daily_price_max: v.number(),
    is_bundle: v.optional(v.boolean()),
    marketing_only: v.optional(v.boolean()),
    created_at: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("pricing_catalog")
      .withIndex("by_name", (q) => q.eq("item_name_canonical", args.item_name_canonical))
      .first();
    if (existing) {
      await patchPricingInput(ctx, existing._id, {
        daily_price_min: args.daily_price_min,
        daily_price_max: args.daily_price_max,
        ...(args.is_bundle !== undefined ? { is_bundle: args.is_bundle } : {}),
        ...(args.marketing_only !== undefined ? { marketing_only: args.marketing_only } : {}),
      }, existing);
      return { action: "updated", id: existing._id };
    }
    const id = await insertPricingInput(ctx, {
      item_name_canonical: args.item_name_canonical,
      daily_price_min: args.daily_price_min,
      daily_price_max: args.daily_price_max,
      is_bundle: args.is_bundle ?? false,
      marketing_only: args.marketing_only ?? false,
      created_at: args.created_at ?? Date.now(),
    });
    return { action: "inserted", id };
  },
});

// B-3: fuzzy lookup for dashboard chat tool
// 3-tier resolver:
//   Tier 1: exact canonical match on pricing_catalog.item_name_canonical (case-insensitive)
//   Tier 2: exact alias match via items table
//   Tier 3: substring match on canonical name or alias (min 5 chars)
export const lookup = query({
  args: { item_name: v.string() },
  handler: async (ctx, { item_name }) => {
    const lower = item_name.toLowerCase().trim();

    // ── Tier 1: exact canonical match on pricing_catalog ─────────────────
    const exactRows = await ctx.db
      .query("pricing_catalog")
      .withIndex("by_name", (q) => q.eq("item_name_canonical", item_name))
      .collect();
    const exactRowsCI =
      exactRows.length > 0
        ? exactRows
        : (await loadPricingRows(ctx)).filter(
            (r) => !r.is_bundle && !r.marketing_only && r.item_name_canonical.toLowerCase() === lower,
          );
    if (exactRowsCI.length > 0) return exactRowsCI.slice(0, 5);

    // ── Tier 2 + 3: resolve via items table (has aliases) ────────────────
    const allItems = await ctx.db.query("items").collect();

    function findItemByName(name: string): { name_canonical?: string } | null {
      const q = name.toLowerCase().trim();
      // T1: exact canonical
      let m: { name_canonical?: string; aliases?: string[] } | undefined = allItems.find(
        (i) => (i.name_canonical ?? "").toLowerCase() === q,
      );
      if (m) return m;
      // T2: exact alias
      m = allItems.find((i) =>
        (i.aliases ?? []).some((a: string) => a.toLowerCase() === q),
      );
      if (m) return m;
      // T3: substring (min 5 chars)
      if (q.length >= 5) {
        m = allItems.find((i) => {
          const canon = (i.name_canonical ?? "").toLowerCase();
          return canon && (canon.includes(q) || q.includes(canon));
        });
        if (m) return m;
        m = allItems.find((i) =>
          (i.aliases ?? []).some((a: string) => {
            const al = a.toLowerCase();
            return al.length >= 5 && (al.includes(q) || q.includes(al));
          }),
        );
        if (m) return m;
      }
      return null;
    }

    const resolvedItem = findItemByName(item_name);
    if (!resolvedItem?.name_canonical) return [];

    // Look up pricing_catalog by the resolved canonical name
    const resolvedCanon = resolvedItem.name_canonical;
    const resolvedRows = await ctx.db
      .query("pricing_catalog")
      .withIndex("by_name", (q) => q.eq("item_name_canonical", resolvedCanon))
      .collect();
    const filtered = resolvedRows.filter((r) => !r.is_bundle && !r.marketing_only);
    if (filtered.length > 0) return filtered.slice(0, 5);

    // Fallback: substring match on all pricing_catalog rows
    const allRows = await loadPricingRows(ctx);
    const lq = lower.replace(/[^a-z0-9]/g, "");
    // First try non-bundle rows only
    const scoreRows = (rows: typeof allRows) =>
      rows
        .map((r) => {
          const cn = r.item_name_canonical.toLowerCase().replace(/[^a-z0-9]/g, "");
          const score = cn === lq ? 3 : cn.includes(lq) ? 2 : lq.includes(cn) && cn.length > 3 ? 1 : 0;
          return { row: r, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || b.row.item_name_canonical.length - a.row.item_name_canonical.length);

    const nonBundleScored = scoreRows(allRows.filter((r) => !r.is_bundle && !r.marketing_only));
    if (nonBundleScored.length > 0) return nonBundleScored.map((x) => x.row).slice(0, 5);

    // Fallback: include bundle rows if no non-bundle match found
    const bundleScored = scoreRows(allRows.filter((r) => !r.marketing_only));
    return bundleScored.map((x) => x.row).slice(0, 5);
  },
});
