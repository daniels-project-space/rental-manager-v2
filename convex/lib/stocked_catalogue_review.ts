import type { Doc } from "../_generated/dataModel";

export const STOCKED_CATALOGUE_SOURCE = "Daniel original GM confirmation and handwritten stocked-kit review, 16 October 2026";
export const STOCKED_CATALOGUE_KEYS = [
  ["dbcinema",1122879], ["dbcinema",1021778], ["diogo",1173541],
  ["dbcinema",958201], ["dbcinema",958197], ["dbcinema",958200], ["dbcinema",958242],
  ["diogo",1173335], ["diogo",1173590], ["diogo",1173591], ["diogo",1173599],
  ["leo",1172491], ["leo",1172476], ["leo",1172472], ["leo",1172467],
  ["leo",1114664], ["leo",1114627], ["leo",1114634], ["leo",1114621],
  ["dbcinema",1025970], ["diogo",1173651],
] as const;
const allowed = new Set(STOCKED_CATALOGUE_KEYS.map(([account,id])=>`${account}#${id}`));
const stable=(value:unknown):unknown=>Array.isArray(value)?value.map(stable):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stable(v)])):value;
const equal=(a:unknown,b:unknown)=>JSON.stringify(stable(a))===JSON.stringify(stable(b));
const escape=(text:string)=>text.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");

/** Only existing owned masters change. Provider listings, rentals and ownership
 * flags are never written. A single Vespid reserves the existing shared set;
 * this deliberately does not invent independently rentable lens quantities. */
export function stockedCatalogueReview(items:Doc<"items">[],products:Doc<"hygglo_products">[]){
  const item=(name:string)=>{
    const matches=items.filter(i=>i.name_canonical===name);
    if(matches.length!==1||matches[0].status!=="active"||matches[0].is_marketing_only||matches[0].qty<=0)throw Error(`Owned inventory identity changed: ${name}`);
    return matches[0];
  };
  const wide=item("Sony GM 16-35mm f2.8"),zoom=item("Sony GM 24-70mm f2.8"),tele=item("Sony GM 70-200mm f2.8"),vespid=item("DZOFilm Vespid 3-Lens Set"),gopro=item("GoPro 12 Hero"),cups=item("Suction cups"),a7v=item("Sony A7 V"),flash=item("Camera flash");
  if(vespid.lens_mount!=="PL"||!["25mm T2.1 lens","50mm T2.1 lens","75mm T2.1 lens"].every(s=>vespid.compatibility?.included_with_rental?.includes(s)))throw Error("The recorded Vespid set changed");
  if(!gopro.compatibility?.included_with_rental?.includes("2x GoPro Enduro battery")||!gopro.compatibility.included_with_rental.includes("1x suction mount")||cups.qty<2)throw Error("The recorded GoPro kit changed");
  if(!flash.compatibility?.included_with_rental?.includes("1x Yongnuo YN560 IV speedlight"))throw Error("The recorded flash identity changed");
  const patches=new Map<string,Partial<Doc<"items">>>();
  const original=(row:Doc<"items">,name:string,code:string)=>{
    patches.set(String(row._id),{rental_facts:{name,source:STOCKED_CATALOGUE_SOURCE},aliases:[...new Set([...(row.aliases??[]),name,code])],notes:[...new Set([...(row.notes??"").split("\n").filter(Boolean),`Original generation ${code}, not GM II; confirmed by Daniel 16 October 2026.`])].join("\n")});
  };
  original(wide,"Sony FE 16–35mm f/2.8 GM (original)","SEL1635GM");
  original(zoom,"Sony FE 24–70mm f/2.8 GM (original)","SEL2470GM");
  const rules=new Map<string,NonNullable<Doc<"items">["listing_stock_rules"]>>();
  const productPatches:Array<{id:Doc<"hygglo_products">["_id"];patch:Partial<Doc<"hygglo_products">>}>=[];
  const reviewedProducts:string[]=[];
  for(const product of products){
    if(!allowed.has(`${product.accountSlug}#${product.productId}`))throw Error("Product is outside the reviewed scope");
    if((product.isMarketingOnlyOverride??product.isMarketingOnly)===true)continue;
    const title=product.name;if(!title)throw Error("Reviewed listing needs its current title");
    let parent:Doc<"items">|undefined,description:string|undefined,components:Array<{item_id:Doc<"items">["_id"];qty:number}>=[];
    if([1025970,1173651].includes(product.productId)){
      if(!/16[–-]35.*24[–-]70.*70[–-]200/.test(title))throw Error("Sony zoom trio identity changed");
      parent=wide;description="Contents: • 1x Sony GM 16-35mm f2.8 • 1x Sony GM 24-70mm f2.8 • 1x Sony GM 70-200mm f2.8";
      if(product.masterItemId!==wide._id||product.stockIdentityOverride?.itemId!==wide._id||product.stockIdentityOverride.title!==title){
        productPatches.push({id:product._id,patch:{masterItemId:wide._id,stockIdentityOverride:{itemId:wide._id,title,source:STOCKED_CATALOGUE_SOURCE}}});
      }
    }else if(product.productId===1122879&&product.accountSlug==="dbcinema"){
      if(product.masterItemId!==a7v._id||!/A7\s*V.*Flash/i.test(title))throw Error("A7 V flash listing changed");
      parent=a7v;components=[{item_id:flash._id,qty:1}];
    }else if([1021778,1173541].includes(product.productId)){
      if(product.masterItemId!==gopro._id||!/go\s*pro/i.test(title))throw Error("Two-camera GoPro listing changed");
      parent=gopro;description="Contents: • 2x GoPro 12 Hero • 2x Suction cups";
    }else{
      if(product.masterItemId!==vespid._id||!/vespid/i.test(title)||/\b(?:16|100|125)mm\b|6[- ]lens|6x/i.test(title))throw Error("Vespid listing identity changed");
      parent=vespid;description="Contents: • 1x DZOFilm Vespid 3-Lens Set";
    }
    const pattern=`^${escape(title)}$`;if(pattern.length>200)throw Error("Reviewed title is too long for an exact stock rule");
    const list=rules.get(String(parent._id))??[];
    if(!list.some(r=>r.title_pattern===pattern))list.push({title_pattern:pattern,components,excludes:[],source:STOCKED_CATALOGUE_SOURCE,...(description?{description_override:description}:{})});
    rules.set(String(parent._id),list);reviewedProducts.push(`${product.accountSlug}#${product.productId}`);
  }
  for(const [id,additions]of rules){
    const row=items.find(i=>String(i._id)===id)!;
    patches.set(id,{...patches.get(id),listing_stock_rules:[...(row.listing_stock_rules??[]).filter(r=>r.source!==STOCKED_CATALOGUE_SOURCE),...additions]});
  }
  return {items:[...patches].flatMap(([id,patch])=>{const row=items.find(i=>String(i._id)===id)!;return Object.entries(patch).some(([key,value])=>!equal(row[key as keyof Doc<"items">],value))?[{id:row._id,name:row.name_canonical,patch}]:[]}),products:productPatches,reviewedProducts};
}
