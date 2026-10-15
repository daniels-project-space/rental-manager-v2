import type { Doc } from "../_generated/dataModel";

export const OWNER_AVAILABILITY_SOURCE = "Daniel confirmed stock identities and supplied parts, 15 October 2026";
const unique=(values:string[])=>[...new Set(values)];
const escape=(text:string)=>text.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");

/** Explicit owner answers, not model guesses. This plan never changes owned
 * quantities, rental records, provider descriptions, messages or payments. */
export function ownerAvailabilityReview(items: Doc<"items">[], products: Doc<"hygglo_products">[]) {
  const item=(name:string)=>{
    const matches=items.filter(i=>i.name_canonical===name);
    if(matches.length!==1)throw Error(`Expected one inventory identity: ${name}`);
    return matches[0];
  };
  const fx3=item("Sony FX3"),card=item("CF Express Type A card"),a7v=item("Sony A7 V"),wide=item("Sony GM 16-35mm f2.8");
  const patches:Array<{id:Doc<"items">["_id"];name:string;patch:Partial<Doc<"items">>}>=[];
  const add=(row:Doc<"items">,patch:Partial<Doc<"items">>)=>patches.push({id:row._id,name:row.name_canonical,patch});
  const supplied=(row:Doc<"items">)=>{
    const existing=row.supplied_stock??[];
    const recorded=existing.find(c=>c.item_id===card._id);
    if(recorded&&recorded.qty!==1)throw Error("Conflicting owner-edited supplied card count");
    return recorded?existing:[...existing,{item_id:card._id,qty:1,source:OWNER_AVAILABILITY_SOURCE}];
  };
  const kit=products.find(p=>p.accountSlug==="leo"&&p.productId===1172943);
  if(!kit?.name || !/fx\s*3.*16-35/i.test(kit.name))throw Error("Reviewed FX3/16–35 listing identity changed");
  const oldFxRules=(fx3.listing_stock_rules??[]).filter(r=>r.source!==OWNER_AVAILABILITY_SOURCE);
  add(fx3,{supplied_stock:supplied(fx3),listing_stock_rules:[...oldFxRules,
    {title_pattern:"FX\\s*3",components:[],excludes:[],source:OWNER_AVAILABILITY_SOURCE,apply_to_declared_component:true,optional_parts:["Sony XLR Handle Unit"]},
    {title_pattern:`^${escape(kit.name)}$`,components:[{item_id:fx3._id,qty:1},{item_id:wide._id,qty:1}],excludes:[],source:OWNER_AVAILABILITY_SOURCE,
      description_override:"Contents: • 1x Sony FX3 • 1x Sony GM 16-35mm f2.8"},
  ]});
  add(a7v,{supplied_stock:supplied(a7v)});
  const tele=item("Sony GM 70-200mm f2.8");
  add(tele,{aliases:unique([...(tele.aliases??[]),"Sony G series 70-200mm lens"])});
  const zoom=item("Sony 28-70mm");
  add(zoom,{aliases:unique([...(zoom.aliases??[]),"Sony FE 28-70mm f3.5-5.6 OSS Zoom Lens","Sony FE 28-70mm f/3.5-5.6 OSS"])});
  add(card,{track_independent_stock:true,aliases:unique([...(card.aliases??[]),"Lexar CFexpress Type A 320GB card","Lexar CFexpress Type A 320GB memory card"]),
    compatibility:{...card.compatibility,included_with_rental:unique([...(card.compatibility?.included_with_rental??[]),"1x Lexar CFexpress Type A card reader"])}} as Partial<Doc<"items">>);
  const mars=item("Hollyland Mars 4K transmitter");
  add(mars,{compatibility:{...mars.compatibility,included_with_rental:unique([...(mars.compatibility?.included_with_rental??[]),"1x Hollyland Mars 4K Receiver"])},
    listing_stock_rules:[...(mars.listing_stock_rules??[]).filter(r=>r.source!==OWNER_AVAILABILITY_SOURCE),{title_pattern:"Hollyland.*Mars.*4K",components:[],excludes:[],source:OWNER_AVAILABILITY_SOURCE,supplied_parts:[{name:"Hollyland Mars 4K Receiver",qty:1}]}]} as Partial<Doc<"items">>);
  // The existing handwritten master explicitly supplies one suction mount
  // per Osmo. Its legacy twin listing lost that line in generated prose.
  const osmo=item("DJI Osmo Action Pro 5"),cups=item("Suction cups");
  if(!osmo.compatibility?.included_with_rental?.includes("1x suction mount") || cups.unit_kind!=="unit")throw Error("Recorded Osmo supplied-mount identity changed");
  const mount=osmo.supplied_stock?.find(c=>c.item_id===cups._id);
  if(mount&&mount.qty!==1)throw Error("Conflicting recorded Osmo supplied-mount count");
  add(cups,{track_independent_stock:true});
  add(osmo,{supplied_stock:mount?osmo.supplied_stock:[...(osmo.supplied_stock??[]),{item_id:cups._id,qty:1,source:"Existing handwritten Osmo master: 1x suction mount per camera"}]});
  const notOwned=products.filter(p=>{
    const name=p.name??"";
    const object=name.split(/\b(?:with|including|plus)\b|[+]/i)[0];
    const absentGimbal=/\b(?:rs\s*4\s*pro|rs\s*2|rsc\s*2)\b/i.test(object)&&!/\bbatter(?:y|ies)\b|\bchargers?\b|\bgrip\b/i.test(object);
    const absentLens=/\bZeiss\b/i.test(name)&&/16\s*[-–]\s*35/.test(name)&&/\bf\s*\/?\s*4\b/i.test(name);
    const absentKit=/\bAmaran\s*300\s*c\b|\bARLES\b|\bSenn?heiser\b[^|]*\bG\s*3\b/i.test(name);
    return absentGimbal||absentLens||absentKit;
  });
  return {items:patches.filter(p=>Object.entries(p.patch).some(([key,value])=>JSON.stringify(items.find(i=>i._id===p.id)?.[key as keyof Doc<"items">])!==JSON.stringify(value))),
    products:notOwned.filter(p=>p.isMarketingOnlyOverride!==true||p.isMarketingOnly!==true).map(p=>({id:p._id,account:p.accountSlug,productId:p.productId,name:p.name,patch:{isMarketingOnly:true,isMarketingOnlyOverride:true}}))};
}
