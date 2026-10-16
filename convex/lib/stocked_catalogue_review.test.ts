import {describe,it,expect} from "vitest";
import {stockedCatalogueReview,STOCKED_CATALOGUE_KEYS,STOCKED_CATALOGUE_SOURCE} from "./stocked_catalogue_review";
import {resolveListingComponents} from "./listing_components";

const snapshot=()=>{
  const items:any[]=[
    {_id:"wide",name_canonical:"Sony GM 16-35mm f2.8",kind:"lens",qty:1},
    {_id:"zoom",name_canonical:"Sony GM 24-70mm f2.8",kind:"lens",qty:4},
    {_id:"tele",name_canonical:"Sony GM 70-200mm f2.8",kind:"lens",qty:2},
    {_id:"nd",name_canonical:"ND filter",kind:"filter",qty:3},
    {_id:"vespid",name_canonical:"DZOFilm Vespid 3-Lens Set",kind:"lens",qty:1,lens_mount:"PL",compatibility:{included_with_rental:["25mm T2.1 lens","50mm T2.1 lens","75mm T2.1 lens","front & rear caps for each lens","hard protective case"]}},
    {_id:"gopro",name_canonical:"GoPro 12 Hero",kind:"camera",qty:3,compatibility:{included_with_rental:["2x GoPro Enduro battery","1x suction mount"]}},
    {_id:"cups",name_canonical:"Suction cups",kind:"accessory",qty:6,track_independent_stock:true},
    {_id:"a7v",name_canonical:"Sony A7 V",kind:"camera",qty:1},
    {_id:"flash",name_canonical:"Camera flash",kind:"lighting",qty:1,compatibility:{included_with_rental:["1x Yongnuo YN560 IV speedlight"]}},
  ].map(i=>({...i,status:"active",is_marketing_only:false,aliases:[],notes:"Existing owner note"}));
  const products:any[]=STOCKED_CATALOGUE_KEYS.map(([accountSlug,productId])=>({
    _id:String(productId),accountSlug,productId,isMarketingOnly:false,
    name:[1048236,1173532].includes(productId)?"Sony 16-35mm GM + Variable ND Filter":[1025970,1173651].includes(productId)?"Sony zoom trio 16-35 / 24-70 / 70-200":productId===1122879?"Sony A7 V + 24-70mm + Flash":productId===1021778||productId===1173541?"2x GoPro HERO12 + 2x Suction Mounts":`DZOFilm Vespid 25mm T2.1 Lens ${productId}`,
    masterItemId:[1048236,1173532].includes(productId)?"wide":[1025970,1173651].includes(productId)?undefined:productId===1122879?"a7v":productId===1021778||productId===1173541?"gopro":"vespid",
  }));
  return {items,products};
};
function apply(data:ReturnType<typeof snapshot>){const plan=stockedCatalogueReview(data.items,data.products);for(const row of plan.items)Object.assign(data.items.find(i=>i._id===row.id),row.patch);for(const row of plan.products)Object.assign(data.products.find(p=>p._id===row.id),row.patch);return plan;}
describe("stocked catalogue review and original Sony generations",()=>{
  it("is pure, preserves all quantities and existing notes, and replays without writes",()=>{
    const data=snapshot(),before=JSON.stringify(data),qty=data.items.map(i=>i.qty);stockedCatalogueReview(data.items,data.products);expect(JSON.stringify(data)).toBe(before);
    apply(data);expect(data.items.map(i=>i.qty)).toEqual(qty);expect(data.items[0].notes).toContain("Existing owner note");expect(apply(data).items).toEqual([]);
  });
  it("records original GM model identities without renaming the canonical inventory keys",()=>{
    const data=snapshot();apply(data);
    expect(data.items[0]).toMatchObject({name_canonical:"Sony GM 16-35mm f2.8",rental_facts:{name:"Sony FE 16–35mm f/2.8 GM (original)"},aliases:expect.arrayContaining(["SEL1635GM"])});
    expect(data.items[1]).toMatchObject({qty:4,rental_facts:{name:"Sony FE 24–70mm f/2.8 GM (original)"},aliases:expect.arrayContaining(["SEL2470GM"])});
  });
  it("leaves every marketing product object unchanged and excludes it from the repair scope",()=>{
    const data=snapshot();data.products[3].isMarketingOnly=true;const before=JSON.stringify(data.products[3]);const plan=apply(data);
    expect(JSON.stringify(data.products[3])).toBe(before);expect(plan.reviewedProducts).not.toContain(`${data.products[3].accountSlug}#${data.products[3].productId}`);
  });
  it("respects an explicit marketing override even when the imported flag is false",()=>{
    const data=snapshot();data.products[0].isMarketingOnlyOverride=true;apply(data);
    expect(data.items.find(i=>i._id==="a7v").listing_stock_rules).toBeUndefined();
  });
  it("reserves one existing Vespid set for a single lens without creating extra lens stock",()=>{
    const data=snapshot();apply(data);const p=data.products[3];
    const result=resolveListingComponents(data.items,undefined,p.masterItemId,1,"A single manual cinema prime",undefined,p.name);
    expect(result).toMatchObject({complete:true,owned:true,components:[{item_id:"vespid",units_per_listing:1}]});
    expect(data.items.filter(i=>/vespid/i.test(i.name_canonical))).toHaveLength(1);
  });
  it("counts both cameras and both supplied suction mounts for the two-GoPro listing",()=>{
    const data=snapshot();apply(data);const p=data.products[1];
    const result=resolveListingComponents(data.items,undefined,p.masterItemId,1,"Old generated text with a misleading 5.7K claim",undefined,p.name);
    expect(result.complete).toBe(true);expect(result.components).toEqual(expect.arrayContaining([expect.objectContaining({item_id:"gopro",units_per_listing:2}),expect.objectContaining({item_id:"cups",units_per_listing:2})]));
  });
  it("adds the real flash to the A7 V allocation rather than merely displaying it",()=>{
    const data=snapshot();apply(data);const p=data.products[0];
    const result=resolveListingComponents(data.items,[{item_id:"a7v",qty:1},{item_id:"zoom",qty:1}],p.masterItemId,1,undefined,undefined,p.name);
    expect(result.components).toEqual(expect.arrayContaining([expect.objectContaining({item_id:"flash",units_per_listing:1})]));
  });
  it("retains unrelated owner rules and does not apply an exact rule after a listing rename",()=>{
    const data=snapshot(),camera=data.items.find(i=>i._id==="gopro");camera.listing_stock_rules=[{title_pattern:"Older owner's exact kit",components:[],excludes:[],source:"prior owner review"}];apply(data);
    expect(camera.listing_stock_rules[0].source).toBe("prior owner review");const p=data.products[1];
    const result=resolveListingComponents(data.items,undefined,p.masterItemId,1,undefined,undefined,"Different GoPro package");
    expect(result.applied_stock_rules.some(r=>r.source===STOCKED_CATALOGUE_SOURCE)).toBe(false);
  });
  it("rejects an unexpected listing, primary identity or six-lens claim",()=>{
    for(const change of [{productId:999999},{masterItemId:"wide"},{name:"DZOFilm Vespid 6x lens set"}]){
      const data=snapshot();Object.assign(data.products[3],change);expect(()=>stockedCatalogueReview(data.items,data.products)).toThrow();
    }
  });
  it("stops when the handwritten packing evidence or a stocked identity changes",()=>{
    const data=snapshot();data.items.find(i=>i._id==="vespid").lens_mount="EF";expect(()=>stockedCatalogueReview(data.items,data.products)).toThrow(/Vespid/);
    const other=snapshot();other.items[0].is_marketing_only=true;expect(()=>stockedCatalogueReview(other.items,other.products)).toThrow(/Owned inventory/);
  });
  it("counts the actual wide lens and ND filter together",()=>{
    const data=snapshot();apply(data);const p=data.products.find(p=>p.productId===1048236);
    const result=resolveListingComponents(data.items,undefined,p.masterItemId,1,"In this kit: • Sony 16-35mm G Master lens • Variable ND filter (2-400 range)",undefined,p.name);
    expect(result).toMatchObject({complete:true,owned:true});expect(result.components.map(c=>[c.item_id,c.units_per_listing])).toEqual([["wide",1],["nd",1]]);
  });
  it("replaces only documented unrelated stocked-item photos and retains a newer owner photo",()=>{
    const data=snapshot();data.items[0].image_url="https://hygglo.imgix.net/products/eddd827d-b517-49f6-80a4-dfe40d8b4118.jpg";data.items[1].image_url="https://owner.example/new-photo.jpg";
    data.items.push({_id:"softbox",name_canonical:"Softbox 85cm",status:"active",is_marketing_only:false,qty:2,image_url:"https://hygglo.imgix.net/products/e68d63_2x-sony-fx3-kit.jpg"});
    apply(data);expect(data.items[0].image_url).toContain("997641-f57897402df21ec5.png");expect(data.items[1].image_url).toBe("https://owner.example/new-photo.jpg");expect(data.items.find(i=>i._id==="softbox").image_url).toContain("listings/881269/");
  });
  it("never updates a marketing inventory thumbnail",()=>{
    const data=snapshot();data.items.push({_id:"softbox",name_canonical:"Softbox 85cm",status:"active",is_marketing_only:true,qty:2,image_url:"https://hygglo.imgix.net/products/e68d63_2x-sony-fx3-kit.jpg"});
    const before=JSON.stringify(data.items.at(-1));apply(data);expect(JSON.stringify(data.items.at(-1))).toBe(before);
  });
});
