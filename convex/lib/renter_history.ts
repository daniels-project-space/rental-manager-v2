import type { QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { rentalStage } from "./rental_stage";

type HistoryRow={_id?:string;hygglo_order_id?:string;status?:string;order_step?:string;is_obsolete?:boolean;awaiting_owner_action?:boolean;start_date?:string;end_date?:string;pickup_date?:string;return_date?:string};
/** Completed or actually in-use rentals establish a business relationship.
 * A request, payment or scheduled collection does not. */
export function priorBusinessRentals(rows:HistoryRow[],threadId:string,today:string){
 const orders=new Set<string>();let last:number|null=null;
 for(const [index,row] of rows.entries()){
  if(row.hygglo_order_id===threadId||!["IN_USE","RETURN_OVERDUE","COMPLETED"].includes(rentalStage(row,today).stage))continue;
  const key=row.hygglo_order_id??row._id??`row:${index}`;if(orders.has(key))continue;orders.add(key);
  const start=row.pickup_date??row.start_date;
  if(!start||!/^\d{4}-\d{2}-\d{2}$/.test(start)||start>today)continue;
  const at=Date.parse(`${start}T00:00:00Z`);
  if(Number.isFinite(at)&&new Date(at).toISOString().slice(0,10)===start&&(last===null||at>last))last=at;
 }
 return {count:orders.size,last_rental_at:last};
}
export async function renterHistory(ctx:QueryCtx,renter:Doc<"renters">|null,threadId:string,today:string){
 if(!renter)return {platform_completed_rentals:null,recorded_rentals_with_us:null,last_rental_with_us_at:null};
 const linked=await ctx.db.query("reservations").withIndex("by_renter",q=>q.eq("renter_id",renter._id)).collect();
 const platform=renter.hygglo_user_id?await ctx.db.query("reservations").withIndex("by_hygglo_user_id",q=>q.eq("hygglo_user_id",renter.hygglo_user_id)).collect():[];
 const rows=[...new Map([...linked,...platform].filter(r=>
  (!r.renter_id||r.renter_id===renter._id)&&(!r.hygglo_user_id||!renter.hygglo_user_id||r.hygglo_user_id===renter.hygglo_user_id)
 ).map(r=>[r._id,r])).values()];
 const prior=priorBusinessRentals(rows,threadId,today);
 return {platform_completed_rentals:renter.platform_completed_rentals??null,recorded_rentals_with_us:prior.count,last_rental_with_us_at:prior.last_rental_at};
}
