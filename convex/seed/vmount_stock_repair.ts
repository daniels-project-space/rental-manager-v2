import { internalMutation } from "../_generated/server";
import { v } from "convex/values";
/** Owner-confirmed catalog metadata only. Never edit renter messages or rental records. */
export const apply=internalMutation({args:{source:v.string()},handler:async(ctx,{source})=>{
 if(source!=="Daniel confirmed 2026-10-13: Chantal BMPCC 6K Pro V-mount kit includes 2x 95Wh; applies to equivalent account listings and website.")throw Error("Owner confirmation does not match this repair.");
 const items=await ctx.db.query("items").collect();
 const named=(name:string)=>{const matches=items.filter(i=>i.name_canonical===name);if(matches.length!==1)throw Error("Physical stock identity is ambiguous");return matches[0];};
 const pro=named("BMPCC 6K Pro"),small=named("V-mount 95Wh"),large=named("V-mount 150Wh");
 if(pro.kind!=="camera"||small.qty!==2||large.qty!==4||[pro,small,large].some(i=>i.status!=="active"||i.is_marketing_only))throw Error("Stock changed; owner review required");
 const rule={title_pattern:"v[ -]?mount",components:[{item_id:small._id,qty:2}],excludes:[large._id],source};
 const old=pro.listing_stock_rules??[];
 if(old.some(r=>r.title_pattern===rule.title_pattern&&JSON.stringify(r)!==JSON.stringify(rule)))throw Error("An existing offering rule needs review");
 if(!old.some(r=>JSON.stringify(r)===JSON.stringify(rule)))await ctx.db.patch(pro._id,{listing_stock_rules:[...old,rule]});
 for(const pool of [small,large])if(pool.track_independent_stock!==true)await ctx.db.patch(pool._id,{track_independent_stock:true});
 await ctx.db.insert("audit_log",{table_name:"items",actor:"owner-confirmed-repair",op:"update",count:3,source_file:"seed/vmount_stock_repair.apply",note:source,ts:Date.now()});
 return {ok:true,scope:"catalog metadata",pool95:small.qty,pool150:large.qty};
}});
