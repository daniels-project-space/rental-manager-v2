import { internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { resolveListingComponents } from "../lib/listing_components";

const source = "Daniel confirmed 14 Oct 2026: each basic/RGB GoPro interview package includes ONE RODE Wireless PRO kit (2 transmitters +1 receiver), not two systems. Supplied accessory counts are from each exact Diogo contents list. No owned quantities or external listings changed.";
const targets = [
  { product:1173687, title:"3x GoPro Hero 12 Multi-Cam Kit | Budget Interview Setup / Rode Wireless Pro Mics", rgb:false, part:"mini camera stands" },
  { product:1173688, title:"GoPro Hero 12 (x3) & Rode Wireless Pro (x2) Kit | Budget 4K Interview Setup /", rgb:true, part:"Compact light stands for the LED panels" },
];
const escapePattern=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");

/** Internal, preview-first owner correction; never touches source text/rentals. */
export const apply=internalMutation({args:{dry_run:v.optional(v.boolean())},handler:async(ctx,args)=>{
  const items=await ctx.db.query("items").take(1000);
  if(items.length===1000)throw Error("Inventory audit bound reached");
  const named=(id:string,name:string,qty:number)=>{
    const item=items.find(i=>String(i._id)===id);
    if(!item||item.name_canonical!==name||item.qty!==qty||item.status!=="active"||item.is_marketing_only)throw Error("Physical inventory changed; review required");
    return item;
  };
  const camera=named("kn72bfr0py9rts0pwfpg2faxvs86a7m2","GoPro 12 Hero",3);
  const audio=named("kn72f7s8b5dkspbqq2eghaxak186a61p","Rode Wireless Mic Pro set",2);
  const lights=named("kn7a3ja3jypm2z1n04wmtfbmd186a8x3","LED light panels RGB",3);
  if(camera.kind!=="camera"||camera.unit_kind!=="unit"||audio.kind!=="audio"||lights.kind!=="lighting"||lights.unit_kind!=="unit")throw Error("Physical inventory roles changed");
  if(audio.unit_kind!=="set"||!audio.compatibility?.included_with_rental?.includes("2x transmitter")||!audio.compatibility.included_with_rental.includes("1x receiver"))throw Error("Wireless PRO kit composition changed");
  const rules=targets.map(t=>({title_pattern:"^"+escapePattern(t.title)+"$",components:[{item_id:audio._id,qty:1}],excludes:[audio._id],source,apply_to_declared_component:true,supplied_parts:[{name:t.part,qty:3}]}));
  const existingRules=camera.listing_stock_rules??[];
  for(const rule of rules){
    const old=existingRules.filter(r=>r.title_pattern===rule.title_pattern),r=old[0];
    if(old.length>1||r&&(r.source!==source||r.apply_to_declared_component!==true||r.components.length!==1||r.components[0].item_id!==audio._id||r.components[0].qty!==1||r.excludes.length!==1||r.excludes[0]!==audio._id||r.supplied_parts?.length!==1||r.supplied_parts[0].name!==rule.supplied_parts[0].name||r.supplied_parts[0].qty!==3))throw Error("Existing offering rule requires review");
  }
  const nextRules=[...existingRules,...rules.filter(rule=>!existingRules.some(r=>r.title_pattern===rule.title_pattern))];
  const nextItems=items.map(i=>i._id===camera._id?{...i,listing_stock_rules:nextRules}:i);
  const plans=[];
  for(const target of targets){
    const products=await ctx.db.query("hygglo_products").withIndex("by_account_product",q=>q.eq("accountSlug","diogo").eq("productId",target.product)).take(2);
    const product=products[0];
    if(products.length!==1||product.name!==target.title||!product.description?.includes("3x GoPro Hero 12 cameras")||!product.description.includes("2x Rode Wireless Pro microphone systems")||!product.description.toLowerCase().includes(target.part.toLowerCase()))throw Error("Exact offering contents changed; re-review required");
    if(product.isMarketingOnlyOverride===true)throw Error("An operator marked this offering marketing-only; review required");
    const components=[{item_id:camera._id,qty:3},{item_id:audio._id,qty:1},...(target.rgb?[{item_id:lights._id,qty:3}]:[])];
    const overrides=await ctx.db.query("listing_resolution_override").withIndex("by_account_product",q=>q.eq("account_slug","diogo").eq("product_id",target.product)).take(2);
    if(overrides.length>1||overrides[0]&&(overrides[0].source!=="manual_audit"||overrides[0].note!==source||JSON.stringify(overrides[0].components)!==JSON.stringify(components)))throw Error("Existing manual mapping requires review");
    const resolved=resolveListingComponents(nextItems,components,product.masterItemId,1,product.description,undefined,product.name);
    if(!resolved.complete||!resolved.owned||resolved.components.length!==components.length||components.some(c=>resolved.components.find(r=>r.item_id===String(c.item_id))?.units_per_listing!==c.qty))throw Error("Owner-confirmed kit identity is not complete");
    plans.push({product:target.product,productRow:product._id,correctMarketing:product.isMarketingOnlyOverride!==false,components,existing:overrides[0]?._id});
  }
  const rulesChanged=nextRules.length!==existingRules.length,marketingCorrected=plans.filter(p=>p.correctMarketing).length,metadataChanged=rulesChanged||marketingCorrected>0,inserted=plans.filter(p=>!p.existing).length;
  if(args.dry_run!==false)return {preview:true,metadataChanged,marketingCorrected,inserted,plans,quantityOwned:{cameras:camera.qty,audioKits:audio.qty,panels:lights.qty}};
  if(rulesChanged)await ctx.db.patch(camera._id,{listing_stock_rules:nextRules});
  // Imported master-link guesses must not override these verified physical
  // kits. The existing importer preserves this explicit internal correction.
  for(const p of plans)if(p.correctMarketing)await ctx.db.patch(p.productRow,{isMarketingOnlyOverride:false,marketingOnlyUpdatedAt:Date.now()});
  for(const p of plans)if(!p.existing)await ctx.db.insert("listing_resolution_override",{account_slug:"diogo",product_id:p.product,components:p.components,note:source,source:"manual_audit",updated_at:Date.now()});
  if(metadataChanged||inserted){
    await ctx.db.insert("audit_log",{table_name:"items/listing_resolution_override/hygglo_products",actor:"owner-confirmed-catalogue-correction",op:"update",count:Number(rulesChanged)+marketingCorrected+inserted,source_file:"seed/gopro_interview_stock_repair.apply",note:source,ts:Date.now()});
    const settings=await ctx.db.query("settings").first();if(settings)await ctx.db.patch(settings._id,{draft_epoch:(settings.draft_epoch??0)+1});
    for(const account of ["diogo","diogo:pending","all","all:pending"]){const cache=await ctx.db.query("mv_reply_queue").withIndex("by_account",q=>q.eq("account",account)).first();if(cache)await ctx.db.delete(cache._id);}
  }
  return {preview:false,metadataChanged,marketingCorrected,inserted,quantityOwned:{cameras:camera.qty,audioKits:audio.qty,panels:lights.qty}};
}});
