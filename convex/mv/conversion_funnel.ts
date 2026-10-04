/**
 * MV: mv_conversion_funnel (pass 11c, 2026-05-25)
 *
 * Wraps reservations.getConversionFunnel. Per Convex billing: ~100GB/month.
 * Reads paginated message/reservation/catalog projections; publishes atomically.
 *
 * Refresher: daily for 3 standard windows (30/90/365 days).
 */
import { v } from "convex/values";
import { internalAction, internalMutation, query } from "../owner_functions";
import { anyApi } from "convex/server";
import { ACCOUNTS, ACCOUNT_ALL } from "./constants";

// Include 7 — the ConversationFunnel widget offers 7/30/90; without a cached
// 7-day row that option fell through to a live compute on every render.
export const STANDARD_WINDOWS = [7, 30, 90, 365] as const;

export const refresh = internalAction({
  args: {},
  handler: async (ctx): Promise<{ ok: true; written: number; durationMs: number }> => {
    return await refreshAll(ctx);
  },
});

export async function refreshAll(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
): Promise<{ ok: true; written: number; durationMs: number }> {
  const startedAt = Date.now();
  const slugs: Array<{ key: string; arg: string | null }> = [
    { key: ACCOUNT_ALL, arg: null },
    ...ACCOUNTS.map((s) => ({ key: s, arg: s })),
  ];
  // 2026-09-02: this used to call getConversionFunnel once per (account,
  // window) — 5 x 4 = 20 COMPLETE scans of hygglo_messages + reservations per
  // refresh. The paginated matrix action builds the per-thread first-contact index once
  // and slices it in memory, so a refresh is now a single scan.
  const cells: Array<{ accountSlug: string | null; days: number; payload: unknown }> =
    await ctx.runAction(anyApi.reservations.computeConversionFunnelMatrix, {
      accounts: slugs.map((s) => s.arg),
      windows: [...STANDARD_WINDOWS],
    });
  const keyForArg = new Map<string | null, string>(slugs.map((s) => [s.arg, s.key]));
  const matrix = cells.map(cell => ({account:keyForArg.get(cell.accountSlug) ?? ACCOUNT_ALL,days:cell.days,payload:cell.payload}));
  await ctx.runMutation(anyApi.mv.conversion_funnel.writeMatrix, {cells:matrix,generatedAt:startedAt});
  return {ok:true,written:matrix.length,durationMs:Date.now()-startedAt};
}

/** Publish every account/window in one transaction after all sources succeed. */
export const writeMatrix = internalMutation({
  args:{cells:v.array(v.object({account:v.string(),days:v.number(),payload:v.any()})),generatedAt:v.number()},
  handler:async(ctx,{cells,generatedAt})=>{
    for(const {account,days,payload} of cells){
      const existing=await ctx.db.query("mv_conversion_funnel").withIndex("by_account_days",q=>q.eq("account",account).eq("days",days)).first();
      if(existing)await ctx.db.patch(existing._id,{payload,generatedAt});
      else await ctx.db.insert("mv_conversion_funnel",{account,days,payload,generatedAt});
    }
    return {ok:true,written:cells.length};
  },
});

export const get = query({
  args: { account: v.optional(v.string()), days: v.number() },
  handler: async (ctx, { account, days }) => {
    const key = account ?? ACCOUNT_ALL;
    return await ctx.db
      .query("mv_conversion_funnel")
      .withIndex("by_account_days", (q) => q.eq("account", key).eq("days", days))
      .first();
  },
});
