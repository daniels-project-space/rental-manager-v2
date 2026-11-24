import {internalMutation} from "./_generated/server";
import {v} from "convex/values";
import {resolveOrderPhysicalItems} from "./lib/renter_order_stock";
import {approvalPhysicalIdentity,approvalReservationWindow,loadStockSources,stockOccupancyForItem,stockWindowPeak} from "./lib/renter_stock";
import {repairHeldUnits} from "./lib/availability";

/** Prepare once before the provider can accept. The inventory read and durable
 * claim insertion share one Convex mutation. No timeout releases an uncertain
 * approval; provider reconciliation is required before another PATCH. */
export const prepareHyggloApproval=internalMutation({
  args:{accountSlug:v.string(),hyggloOrderId:v.string()},
  handler:async(ctx,{accountSlug,hyggloOrderId})=>{
    if(!accountSlug||!hyggloOrderId||accountSlug==="dbcinema_web"||hyggloOrderId.startsWith("__probe__"))throw Error("Invalid provider approval identity");
    const prior=await ctx.db.query("stock_approval_claims").withIndex("by_order",q=>q.eq("account_slug",accountSlug).eq("order_id",hyggloOrderId)).collect();
    if(prior.length)throw Error("This approval requires provider reconciliation before retrying");
    const rows=await ctx.db.query("reservations").withIndex("by_hygglo_order_id",q=>q.eq("hygglo_order_id",hyggloOrderId)).collect();
    const candidates=rows.filter(r=>r.account_slug===accountSlug);
    if(candidates.length!==1)throw Error("The approval's source rental is missing or ambiguous");
    const rental=candidates[0];
    if(rental.is_obsolete||rental.order_step!=="REQUEST"||["cancelled","declined","completed","confirmed","ongoing"].includes(rental.status))throw Error("Only a current provider request can prepare approval stock");
    if(!rental.hygglo_items?.length)throw Error("The approval needs the original provider equipment basket");
    const sources=await loadStockSources(ctx);
    const resolved=await resolveOrderPhysicalItems(ctx,accountSlug,rental.hygglo_items.map(i=>({name:i.name,qty:i.qty??1,product_id:i.product_id})),sources.items);
    if(!resolved.items.length)throw Error("The approval's physical equipment mapping needs reconciliation");
    const window=approvalReservationWindow(rental);
    const request={item_name:"",start_date:window.start.slice(0,10),end_date:window.end.slice(0,10)};
    const intersects=(b:{start_date:string;end_date:string})=>`${b.start_date}T00:00`<window.end&&`${new Date(Date.parse(b.end_date+"T00:00Z")+86400000).toISOString().slice(0,10)}T00:00`>window.start;
    const components=resolved.items.map(({item_id,quantity})=>{
      const item=sources.items.find(i=>String(i._id)===item_id);
      if(!item||item.status!=="active"||item.is_marketing_only!==false||!Number.isSafeInteger(item.qty)||item.qty<0||!Number.isSafeInteger(quantity)||quantity<1)throw Error("The approval includes equipment without verified owned capacity");
      const occupancy=stockOccupancyForItem(sources,item,{...request,item_name:item.name_canonical});
      const occupied=stockWindowPeak(occupancy,window.start,window.end);
      const repair=repairHeldUnits(sources.claims,item._id);
      if(!Number.isSafeInteger(occupied)||!Number.isSafeInteger(repair)||sources.vacations.some(intersects)||sources.blackouts.some(b=>b.item_id===item._id&&intersects(b))||occupied+repair+quantity>item.qty)throw Error(`Not enough available equipment to approve ${item.name_canonical}`);
      return {item_id:item._id,qty:quantity};
    });
    const physical_fingerprint=approvalPhysicalIdentity(window.start,window.end,new Map(components.map(c=>[String(c.item_id),c.qty])));
    const claimId=await ctx.db.insert("stock_approval_claims",{reservation_id:rental._id,account_slug:accountSlug,order_id:hyggloOrderId,physical_fingerprint,...window,components,prepared_at:Date.now()});
    return {claimId,physicalFingerprint:physical_fingerprint};
  },
});
