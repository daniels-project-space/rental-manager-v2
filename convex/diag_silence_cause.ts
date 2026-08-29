import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

/**
 * Is the bot's silence a MODEL problem or a DATA problem?
 *
 * The shadow run against real traffic blocked 11 of 40 replies, and the two
 * rules doing almost all of it were "asserts availability with no item
 * grounding" and "quotes a price with no pricing grounding for this item".
 * Both fire when the bot answers from listing prose because no tool could
 * supply a grounded fact.
 *
 * That is the signature of an UNMAPPED listing, not a badly behaved model — and
 * unmapped listings are a known, counted backlog here. If the blocked threads
 * are disproportionately the ones whose product ids have no mapping, the fix is
 * finishing the mapping rather than tuning the prompt.
 *
 * Answers that by joining product ids from blocked and answered threads against
 * the mapping tables, so the two groups can be compared instead of a single
 * number being read as proof.
 */
export const check = internalQuery({
  args: {
    blocked_pids: v.array(v.number()),
    answered_pids: v.array(v.number()),
  },
  handler: async (ctx, { blocked_pids, answered_pids }) => {
    const overrides = await ctx.db.query("listing_resolution_override").collect();
    const index = await ctx.db.query("hygglo_product_index").collect();
    const products = await ctx.db.query("hygglo_products").collect();

    const overrideIds = new Set(overrides.map((o) => o.product_id));
    const indexIds = new Set(index.map((i) => i.product_id));
    const pricedIds = new Set(
      products
        .filter((p) => Array.isArray(p.prices) && p.prices.length > 0)
        .map((p) => p.productId),
    );

    const summarise = (pids: number[]) => {
      const uniq = [...new Set(pids)];
      return {
        product_ids: uniq.length,
        mapped: uniq.filter((p) => overrideIds.has(p) || indexIds.has(p)).length,
        unmapped: uniq.filter((p) => !overrideIds.has(p) && !indexIds.has(p)).length,
        with_price_tiers: uniq.filter((p) => pricedIds.has(p)).length,
        without_price_tiers: uniq.filter((p) => !pricedIds.has(p)).length,
      };
    };

    return {
      blocked: summarise(blocked_pids),
      answered: summarise(answered_pids),
      totals: {
        overrides: overrideIds.size,
        product_index: indexIds.size,
        products_with_price_tiers: pricedIds.size,
      },
    };
  },
});

export default internalAction({
  args: {
    blocked_pids: v.array(v.number()),
    answered_pids: v.array(v.number()),
  },
  handler: async (ctx, args): Promise<unknown> =>
    ctx.runQuery(internal.diag_silence_cause.check, args),
});
