import { internalQuery, type ActionCtx } from "../_generated/server";
import { anyApi } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { reservationReadGate, decodeReservationRead } from "../lib/reservation_read_model";
import { readFullInventory } from "../lib/inventory_read";
import { loadPricingRows } from "../lib/pricing_input_cache";
import type { SlowAnalyticsSnapshot, SnapshotResult } from "../lib/analytics_source_order";

type Metadata = Omit<SlowAnalyticsSnapshot,"reservations">;
type Captured =
  | (Metadata & { mode:"source"; reservations:Doc<"reservations">[] })
  | (Metadata & { mode:"records"; records:Doc<"reservation_read_records">[] })
  | { mode:"fallback"; reason:string };

async function optionalSnapshot<T>(work:()=>Promise<T>):Promise<SnapshotResult<T>> {
  try{return {ok:true,value:await work()};}
  catch(error){return {ok:false,error:error instanceof Error?error.message:String(error)};}
}

/** One immutable database snapshot for the daily analytics inputs. Current
 * cardinality (17 Oct 2026): 4,866 reservations, 108 items, 474 prices,
 * 41 bundles, 141 bundle components and 408 overrides. Keep complete rows.
 * Encoded records defer decompression to the action's longer CPU budget. */
export const capture = internalQuery({
  args:{ forceSource:v.optional(v.boolean()) },
  handler:async(ctx,args):Promise<Captured>=>{
    let records:Doc<"reservation_read_records">[]|undefined;
    if(!args.forceSource){
      const gate=await reservationReadGate(ctx).catch(()=>null);
      if(gate?.enabled&&gate.ready&&gate.version===1){
        records=await ctx.db.query("reservation_read_records").withIndex("by_source_creation_time").collect();
        const ids=new Set<string>(),times=new Set<number>();
        for(const row of records){
          if(!row.valid||row.version!==1||!Number.isFinite(row.source_creation_time)||ids.has(String(row.source_id))||times.has(row.source_creation_time)){
            return {mode:"fallback",reason:"Unusable or ambiguous full reservation record set"};
          }
          ids.add(String(row.source_id));times.add(row.source_creation_time);
        }
        if(!records.length)return {mode:"fallback",reason:"Empty optional reservation record set"};
      }
    }
    const [items,pricing,bundleDefinitions,attributionOverrides]=await Promise.all([
      readFullInventory(ctx),loadPricingRows(ctx),
      optionalSnapshot(async()=>{
        const [bundles,bundleItems]=await Promise.all([ctx.db.query("bundles").collect(),ctx.db.query("bundle_items").collect()]);
        return {bundles,bundleItems};
      }),
      optionalSnapshot(()=>ctx.db.query("listing_resolution_override").collect()),
    ]);
    const metadata:Metadata={items,pricing,bundleDefinitions,attributionOverrides,capturedAt:Date.now()};
    if(records)return {...metadata,mode:"records",records};
    const reservations=await ctx.db.query("reservations").withIndex("by_creation_time").collect();
    return {...metadata,mode:"source",reservations};
  },
});

/** Corrupt/unsupported optional records never become partial analytics.
 * Decode in bounded batches; a single fresh source capture replaces the
 * ENTIRE snapshot on failure, retaining cross-table snapshot consistency. */
export async function loadSlowAnalyticsSnapshot(ctx:ActionCtx):Promise<SlowAnalyticsSnapshot> {
  const captured:Captured=await ctx.runQuery(anyApi.mv.slow_inputs.capture,{});
  if(captured.mode==="source"){
    const {mode,...snapshot}=captured;
    return snapshot;
  }
  if(captured.mode==="records"){
    try{
      const reservations:Doc<"reservations">[]=[];
      for(let start=0;start<captured.records.length;start+=64){
        reservations.push(...await Promise.all(captured.records.slice(start,start+64).map(decodeReservationRead)));
      }
      const {mode,records,...metadata}=captured;
      return {...metadata,reservations};
    }catch{ /* Optional record validation failed. Read one fresh full snapshot. */ }
  }
  const source:Captured=await ctx.runQuery(anyApi.mv.slow_inputs.capture,{forceSource:true});
  if(source.mode!=="source")throw Error("Full source snapshot fallback was unavailable");
  const {mode,...snapshot}=source;
  return snapshot;
}
