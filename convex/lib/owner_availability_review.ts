import type { Doc } from "../_generated/dataModel";

export const OWNER_AVAILABILITY_SOURCE = "Daniel confirmed stock identities and supplied parts, 15 October 2026";
const unique=(values:string[])=>[...new Set(values)];
const escape=(text:string)=>text.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
const stable=(value:unknown):unknown=>Array.isArray(value)?value.map(stable):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,entry])=>[key,stable(entry)])):value;

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
  // Latest owner confirmation supersedes the old handwritten CFexpress line.
  const sd=item("256GB card");
  const legacyA7Card=(a7v.supplied_stock??[]).find(c=>c.item_id===card._id);
  if(legacyA7Card&&legacyA7Card.source!==OWNER_AVAILABILITY_SOURCE)throw Error("Unreviewed A7 V card allocation changed");
  add(a7v,{supplied_stock:[...(a7v.supplied_stock??[]).filter(c=>c.item_id!==card._id&&c.item_id!==sd._id),{item_id:sd._id,qty:1,source:"Daniel confirmed A7 V includes one 256GB V90 SD card, 16 October 2026"}],
    compatibility:{...a7v.compatibility,cards:unique([...(a7v.compatibility?.cards??[]),"256GB SDXC V90 card"]),included_with_rental:unique([...(a7v.compatibility?.included_with_rental??[]).filter(s=>!/^CF Express Type A card$/i.test(s)),"1x 256GB SDXC V90 card"])}} as Partial<Doc<"items">>);
  add(sd,{aliases:unique([...(sd.aliases??[]),"256GB SDXC V90 card"]),track_independent_stock:true});
  const pyro=item("Hollyland Pyro S transmitter"),monitor=item("Hollyland 7-inch monitor");
  const pyroSource="Daniel confirmed Pyro S paired receiver included, 16 October 2026";
  add(pyro,{compatibility:{...pyro.compatibility,included_with_rental:unique([...(pyro.compatibility?.included_with_rental??[]),"1x Hollyland Pyro S Receiver","8x Detachable antennas"])},
    listing_stock_rules:[...(pyro.listing_stock_rules??[]).filter(r=>r.source!==pyroSource),{title_pattern:"Hollyland.*Pyro.*S",components:[],excludes:[],source:pyroSource,apply_to_declared_component:true,supplied_parts:[{name:"Hollyland Pyro S Receiver",qty:1},{name:"Hollyland Pyro S Receiver (RX)",qty:1},{name:"Detachable antennas",qty:8}]},
      {title_pattern:"Hollyland.*Pyro.*S.*(?:7|monitor)",components:[{item_id:monitor._id,qty:1}],excludes:[],source:pyroSource,apply_to_declared_component:true,
        description_override:"Contents: • 1x Hollyland Pyro S transmitter • 1x Hollyland Pyro S Receiver • 8x Detachable antennas • 1x Hollyland 7-inch monitor • 4x NP-F style batteries • 1x Dual battery charger • 2x HDMI cables • 1x SDI cable • 1x Carry case"}]} as Partial<Doc<"items">>);
  const tele=item("Sony GM 70-200mm f2.8");
  add(tele,{aliases:unique([...(tele.aliases??[]),"Sony G series 70-200mm lens","Sony FE 70-200mm f2.8 GM OSS SEL70200GM","Sony FE 70-200mm f/2.8 GM OSS (original)"]),
    notes:unique([...(tele.notes??"").split("\n"),"Both owned lenses are original Sony FE 70–200mm f/2.8 GM OSS (SEL70200GM), not GM II; confirmed by Daniel 16 October 2026."]).filter(Boolean).join("\n"),
    listing_stock_rules:[...(tele.listing_stock_rules??[]).filter(r=>r.source!=="Daniel confirmed original GM and attached collar, 16 October 2026"),{title_pattern:"Sony.*70[-–]200",components:[],excludes:[],source:"Daniel confirmed original GM and attached collar, 16 October 2026",apply_to_declared_component:true,supplied_parts:[{name:"Tripod collar attached",qty:1},{name:"Tripod collar (attached)",qty:1}]}],
    image_url:"https://pub-761e4d18b3b84542809dddc11936a8df.r2.dev/listings/1048172/0.jpg"});
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
    // Trailing SEO compatibility keywords ("RS3 ... RS2, RS4") do not
    // change the advertised gimbal into one of the owner's absent models.
    const firstGimbal=object.match(/\b(?:rsc\s*2|rs\s*[234](?:\s*pro)?)\b/i)?.[0].replace(/\s/g,"").toLowerCase();
    const absentGimbal=!!firstGimbal&&["rs4pro","rs2","rs2pro","rsc2"].includes(firstGimbal)&&!/\bbatter(?:y|ies)\b|\bchargers?\b|\bgrip\b/i.test(object);
    const absentLens=/\bZeiss\b/i.test(name)&&/16\s*[-–]\s*35/.test(name)&&/\bf\s*\/?\s*4\b/i.test(name);
    const absentKit=/\bAmaran\s*300\s*c\b|\bARLES\b|\bSenn?heiser\b[^|]*\bG\s*3\b/i.test(name);
    return absentGimbal||absentLens||absentKit;
  });
  const repairedA7=products.filter(p=>/Sony.*(?:A7\s*V\b|Alpha\s*7\s*V\b)/i.test(p.name??"")&&(p.masterItemId!==a7v._id||p.stockIdentityOverride?.itemId!==a7v._id||p.stockIdentityOverride?.title!==p.name))
    .map(p=>({id:p._id,account:p.accountSlug,productId:p.productId,name:p.name,patch:{masterItemId:a7v._id,stockIdentityOverride:{itemId:a7v._id,title:p.name!,source:"Daniel confirmed A7 V kit identity, 16 October 2026"}}}));
  const repairedPyro=products.filter(p=>/Hollyland.*Pyro\s*S\b/i.test(p.name??"") && (p.masterItemId!==pyro._id||p.stockIdentityOverride?.itemId!==pyro._id||p.stockIdentityOverride?.title!==p.name))
    .map(p=>({id:p._id,account:p.accountSlug,productId:p.productId,name:p.name,patch:{masterItemId:pyro._id,stockIdentityOverride:{itemId:pyro._id,title:p.name!,source:pyroSource}}}));
  return {items:patches.filter(p=>Object.entries(p.patch).some(([key,value])=>JSON.stringify(stable(items.find(i=>i._id===p.id)?.[key as keyof Doc<"items">]))!==JSON.stringify(stable(value)))),
    products:[...repairedA7,...repairedPyro,...notOwned.filter(p=>p.isMarketingOnlyOverride!==true||p.isMarketingOnly!==true).map(p=>({id:p._id,account:p.accountSlug,productId:p.productId,name:p.name,patch:{isMarketingOnly:true,isMarketingOnlyOverride:true}}))]};
}
