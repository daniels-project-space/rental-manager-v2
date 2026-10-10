import type {QueryCtx} from "../_generated/server";
import {claimHoldsStock} from "./availability";
export async function loadStockRepairs(ctx:QueryCtx){
 const rows=(await Promise.all(["quote_received","in_for_repair"].map(stage=>ctx.db.query("insurance_claims").withIndex("by_stage",q=>q.eq("stage",stage)).take(1001)))).flat();
 if(rows.length>1000)throw Error("Repair inventory requires paged reconciliation");
 const counts=new Map<string,number>();
 for(const c of rows.filter(claimHoldsStock))for(const id of c.repair_item_ids??[])counts.set(String(id),(counts.get(String(id))??0)+1);
 return counts;
}
