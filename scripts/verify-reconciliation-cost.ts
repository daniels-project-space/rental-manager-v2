import { readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { listBatch } from "../convex/reconciliation";
import { computeHoldsForReservations } from "../src/lib/reconcile-holds";

const snapshot = JSON.parse(readFileSync(process.argv[2], "utf8"));
const today = new Date();
const lookback = new Date(today); lookback.setUTCDate(lookback.getUTCDate()-400);
const cutoff = lookback.toISOString().slice(0,10);
const fields = ["_id","hygglo_order_id","account_slug","start_date","end_date","pickup_date","return_date","order_step","status","is_obsolete","items","resolved_items","expanded_items","renter_name"];
const reports: object[] = [];
process.env.OWNER_AUTH_REQUIRED = "false";

function ctxFor() {
  let readBytes=0, readRows=0;
  const ctx:any = { db: { get:async(id:string)=>{const row=snapshot.reservations.find((r:any)=>r._id===id);if(row){readRows++;readBytes+=Buffer.byteLength(JSON.stringify(row));}return row??null;},query: (table:string) => {
    let selected: Record<string, any>[] = snapshot[table];
    const chain:any={withIndex: (_name:string, fn:any) => {
      const q:any={eq:(key:string,value:any)=>{selected=selected.filter(row=>row[key]===value);return q;},gte:(key:string,value:any)=>{selected=selected.filter(row=>row[key]>=value);return q;}};
      fn(q);return chain;
    },collect:async()=>{readRows+=selected.length;readBytes+=Buffer.byteLength(JSON.stringify(selected));return selected;},take:async(n:number)=>{const rows=selected.slice(0,n);readRows+=rows.length;readBytes+=Buffer.byteLength(JSON.stringify(rows));return rows;}};
    return chain;
  } } };
  return {ctx,metrics:()=>({readBytes,readRows})};
}

function result(rows:any[], account:string) {
  const productIndex = new Map(snapshot.hygglo_product_index.filter((r:any)=>r.account_slug===account).map((r:any)=>[`${account}#${r.product_id}`,String(r.item_id)]));
  const bundleOverrides = new Map(snapshot.listing_resolution_override.filter((r:any)=>r.account_slug===account).map((r:any)=>[`${account}#${r.product_id}`,r.components]));
  return computeHoldsForReservations({today,items:snapshot.reconcile_items.map((i:any)=>({...i,_id:String(i._id)})),
    reservations:rows.map(r=>({...r,start_date:r.start_date??null,end_date:r.end_date??null,
      ...(r.pickup_date&&r.start_date&&r.pickup_date<r.start_date?{pickup_at:Date.parse(r.pickup_date+"T00:00:00Z")} : {}),
      ...(r.return_date&&r.end_date&&r.return_date>r.end_date?{return_at:Date.parse(r.return_date+"T00:00:00Z")} : {}),
    })),productIndex:productIndex as any,bundleOverrides:bundleOverrides as any});
}

async function main() {
  const accounts=[...new Set<string>(snapshot.reservations.map((r:any)=>r.account_slug).filter(Boolean))];
  const {ctx,metrics}=ctxFor();
  const batch=await (listBatch as any)._handler(ctx,{account_slugs:accounts});
  for(const account of accounts) {
    const previousRows=snapshot.reservations.filter((r:any)=>r.account_slug===account&&r.start_date>=cutoff)
      .sort((a:any,b:any)=>a.start_date.localeCompare(b.start_date)||a._creationTime-b._creationTime);
    const previous=previousRows.map((r:any)=>Object.fromEntries(fields.filter(k=>r[k]!==undefined).map(k=>[k,r[k]])));
    const next=batch.groups.find((group:any)=>group.account_slug===account).reservations;
    const before=result(previous,account),after=result(next,account);
    for(const key of ["holds","unmatchedItemNames","unresolvedLines"] as const)
      if(!isDeepStrictEqual(before[key],after[key]))throw new Error(`${account} changed ${key}`);
    const deletedBefore=snapshot.calendar_holds.filter((h:any)=>before.deleteReservationIds.includes(h.reservation_id)).map((h:any)=>h._id);
    const deletedAfter=snapshot.calendar_holds.filter((h:any)=>after.deleteReservationIds.includes(h.reservation_id)).map((h:any)=>h._id);
    if(!isDeepStrictEqual(deletedBefore,deletedAfter))throw new Error(`${account} changed actual hold cleanup`);
    reports.push({account,originalRows:previousRows.length,selectedRows:next.length,originalDocumentBytes:Buffer.byteLength(JSON.stringify(previousRows)),
      holds:after.holds.length,cleanupIds:after.deleteReservationIds.length,unresolvedLines:after.unresolvedLines.length,equivalent:true});
  }
  const receipt={at:today.toISOString(),basis:"real production snapshot; document byte estimates, not provider billing measurements",strategy:batch.strategy,batchRead:metrics(),reports};
  writeFileSync(process.argv[3],JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
