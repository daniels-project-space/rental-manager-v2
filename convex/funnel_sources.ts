import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalQuery } from "./owner_functions";
import { projectFunnelSource } from "./lib/funnel_sources";

/** Each page has its own read budget; large transcripts never leave Native. */
export const readPage = internalQuery({
  args:{table:v.union(v.literal("hygglo_messages"),v.literal("reservations"),v.literal("items"),v.literal("hygglo_product_index"),v.literal("listing_resolution_override"),v.literal("online_listings")),asOf:v.number(),paginationOpts:paginationOptsValidator},
  handler:async(ctx,{table,asOf,paginationOpts})=>{
    const result=await ctx.db.query(table).withIndex("by_creation_time",q=>q.lte("_creationTime",asOf)).paginate(paginationOpts);
    return {...result,page:result.page.map(row=>projectFunnelSource(table,row))};
  },
});
