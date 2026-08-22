import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

/**
 * Refresh the cached listing price from the daily-synced Hygglo catalog.
 *
 * Two tables hold a listing's price and they drift apart:
 *   - `hygglo_products.prices`  — synced DAILY by catalog-sync, and carries the
 *     full multi-day tier table (1 / 3 / 7 / 30 day rates)
 *   - `online_listings.daily_price` — only ever refreshed by a manual "Rescan
 *     listings" click in Settings
 *
 * The renter-facing tools read the CACHED one, so every disagreement is a wrong
 * number quoted to a real renter. Measured 2026-08-22: ALL 369 of diogo's
 * listings were stale and every one was BELOW the live price (£295 cached vs
 * £325 live, £225 vs £248) — roughly 10% under, i.e. we were quoting less than
 * Hygglo charges on an entire account.
 *
 * This copies the live 1-day rate over the cached one. It reads only Convex —
 * catalog-sync has already done the Hygglo fetch — so it is cheap enough to run
 * after every catalog sync.
 */
export const plan = internalQuery({
  args: { account_slug: v.string() },
  handler: async (ctx, { account_slug }) => {
    const listings = await ctx.db
      .query("online_listings")
      .withIndex("by_account", (q) => q.eq("account_slug", account_slug))
      .collect();
    const byPid = new Map(
      (await ctx.db.query("hygglo_products").collect())
        .filter((p) => p.accountSlug === account_slug)
        .map((p) => [p.productId, p]),
    );
    const updates: Array<{ id: string; product_id: number; from: number | null; to: number }> = [];
    for (const l of listings) {
      const live = (byPid.get(l.product_id)?.prices ?? []).find((p) => p.days === 1)
        ?.pricePerDay;
      if (typeof live !== "number" || live <= 0) continue;
      const cached = l.daily_price ?? null;
      // Round: Hygglo reports 15.714285714285714 for a 7-day tier, and the
      // 1-day rate is always a whole number in practice.
      if (cached != null && Math.round(cached) === Math.round(live)) continue;
      updates.push({
        id: String(l._id),
        product_id: l.product_id,
        from: cached,
        to: Math.round(live),
      });
    }
    return { account_slug, listings: listings.length, stale: updates.length, updates };
  },
});

export const apply = internalMutation({
  args: {
    updates: v.array(v.object({ id: v.string(), to: v.number() })),
  },
  handler: async (ctx, { updates }) => {
    let patched = 0;
    for (const u of updates) {
      const row = await ctx.db.get(u.id as never);
      if (!row) continue;
      await ctx.db.patch(u.id as never, { daily_price: u.to, updated_at: Date.now() });
      patched++;
    }
    return { patched };
  },
});

/**
 * Dry run by default — pass `{ confirm: true }` to write. Reports the drift it
 * would fix so the numbers can be eyeballed before an account-wide price change
 * reaches anything a renter sees.
 */
export const refresh = internalAction({
  args: { account_slug: v.string(), confirm: v.optional(v.boolean()) },
  handler: async (ctx, { account_slug, confirm }): Promise<unknown> => {
    const p = (await ctx.runQuery(internal.listing_price_sync.plan, {
      account_slug,
    })) as {
      listings: number;
      stale: number;
      updates: Array<{ id: string; product_id: number; from: number | null; to: number }>;
    };
    if (!confirm) {
      return {
        dry_run: true,
        account_slug,
        listings: p.listings,
        would_update: p.stale,
        sample: p.updates.slice(0, 8),
      };
    }
    const res = (await ctx.runMutation(internal.listing_price_sync.apply, {
      updates: p.updates.map((u) => ({ id: u.id, to: u.to })),
    })) as { patched: number };
    return { account_slug, listings: p.listings, patched: res.patched };
  },
});

/**
 * All accounts, run daily just after catalog-sync (cron "37 4 * * *") has
 * refreshed hygglo_products. Without this the cache silently re-stales: it is
 * only otherwise updated by a manual Settings click, which is how an entire
 * account drifted ~10% below its own live prices unnoticed.
 */
export const refreshAllDaily = internalAction({
  args: {},
  handler: async (ctx): Promise<unknown> => {
    const out: Record<string, number> = {};
    for (const slug of ["leo", "dbcinema", "diogo"]) {
      const p = (await ctx.runQuery(internal.listing_price_sync.plan, {
        account_slug: slug,
      })) as { updates: Array<{ id: string; to: number }> };
      const res = (await ctx.runMutation(internal.listing_price_sync.apply, {
        updates: p.updates.map((u) => ({ id: u.id, to: u.to })),
      })) as { patched: number };
      out[slug] = res.patched;
    }
    return out;
  },
});
