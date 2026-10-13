import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
export const receive=internalMutation({args:{revision:v.number(),rows:v.array(v.object({bookingId:v.string(),masterItemId:v.string(),start:v.number(),end:v.number(),qty:v.number(),expiresAt:v.number(),endExclusive:v.boolean(),bufferMinutes:v.number()}))},handler:async(ctx,a)=>{
 if(!Number.isSafeInteger(a.revision)||a.revision<1||a.revision>Date.now()+60000||a.rows.length>500)throw Error("Invalid stock snapshot");
 const previous=await ctx.db.query("storefront_checkout_stock").withIndex("by_key",q=>q.eq("key","website")).unique();
 if(previous&&previous.revision>=a.revision)return {ok:true,revision:previous.revision};
 const rows=[];
 for(const row of a.rows){
  const itemId=ctx.db.normalizeId("items",row.masterItemId);
  if(!itemId||!await ctx.db.get(itemId)||!/^[a-zA-Z0-9_-]{1,80}$/.test(row.bookingId)||!Number.isSafeInteger(row.qty)||row.qty<1||row.qty>100||![row.start,row.end,row.expiresAt,row.bufferMinutes].every(Number.isSafeInteger)||row.end<row.start||row.bufferMinutes<0||row.bufferMinutes>1440||row.expiresAt>Date.now()+36*60000)throw Error("Invalid stock identity or window");
  const {masterItemId,...rest}=row;rows.push({...rest,item_id:itemId});
 }
 const update={key:"website",revision:a.revision,rows,receivedAt:Date.now()};
 if(previous)await ctx.db.patch(previous._id,update);else await ctx.db.insert("storefront_checkout_stock",update);
 return {ok:true,revision:a.revision};
}});
