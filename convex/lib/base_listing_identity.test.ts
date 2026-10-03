import { describe, it, expect } from "vitest";
import { baseListingProductIds, chooseBaseListing } from "./base_listing_identity";
const items = [{ _id: "body", name_canonical: "Sony FX3", kind: "camera" }, { _id: "card", name_canonical: "CFexpress card", kind: "storage_card" }, { _id: "lens", name_canonical: "Sony 24-70mm", kind: "lens" }];
const index = [{ account_slug: "leo", product_id: 1, item_id: "body" }];
const ids = (components: Array<{ item_id: string; qty: number }>, target = "body") => baseListingProductIds("leo", target, index, [{ account_slug: "leo", product_id: 1, components }], items);
describe("base listing identity", () => {
  it("rejects a legacy body-only fallback even when advertising cannot be parsed",()=>{
    expect(baseListingProductIds("leo","body",index,[{account_slug:"leo",product_id:1,note:"description [body-only-fallback]",components:[{item_id:"body",qty:1}]}],items)).toEqual([]);
  });
  it("uses currently verified contents rather than an obsolete fallback audit note",()=>{
    const mapping=[{account_slug:"leo",product_id:1,note:"old body-only-fallback; later repaired",components:[{item_id:"body",qty:1}]}];
    expect(baseListingProductIds("leo","body",index,mapping,items,[{product_id:1,description:"Included in this rental: • Sony FX3 • 1TB SSD"}])).toEqual([1]);
  });
  it("rejects missing equipment in an explicit kit before it becomes a base body price",()=>{
    const listings=[{product_id:1,description:"Included in this rental: • Sony FX3 • Sony 24-70mm"}];
    const mapping=[{account_slug:"leo",product_id:1,components:[{item_id:"body",qty:1}]}];
    expect(baseListingProductIds("leo","body",index,mapping,items,listings)).toEqual([]);
    expect(baseListingProductIds("leo","body",index,[],items,listings)).toEqual([]);
  });
  it("keeps a verified body with incidental supplied media as a base offering",()=>{
    const listings=[{product_id:1,description:"Included in this rental: • Sony FX3 • 1TB SSD • 5x batteries"}];
    expect(baseListingProductIds("leo","body",index,[{account_slug:"leo",product_id:1,components:[{item_id:"body",qty:1}]}],items,listings)).toEqual([1]);
  });
  it("does not assume unresolved advertised lenses are incidental accessories",()=>{
    const listings=[{product_id:1,description:"Included in this rental: • Sony FX3 • Great Joy Anamorphic Lens Set – 35mm, 50mm, 85mm"}];
    expect(baseListingProductIds("leo","body",index,[{account_slug:"leo",product_id:1,components:[{item_id:"body",qty:1}]}],items,listings)).toEqual([]);
  });
  it("prices a camera with its recorded supplied adapter without pricing the adapter from that camera",()=>{
    const inventory=[{_id:"ff",name_canonical:"BMPCC 6K Full Frame",kind:"camera",compatibility:{included_with_rental:["EF to L mount adapter"]}},{_id:"adapter",name_canonical:"EF to L mount",aliases:["EF to L mount adapter"],kind:"adapter"}];
    const mapping=[{account_slug:"leo",product_id:10,components:[{item_id:"ff",qty:1},{item_id:"adapter",qty:1}]}];
    expect(baseListingProductIds("leo","ff",[],mapping,inventory)).toEqual([10]);
    expect(baseListingProductIds("leo","adapter",[],mapping,inventory)).toEqual([]);
    expect(baseListingProductIds("leo","ff",[],[{...mapping[0],components:[{item_id:"ff",qty:1},{item_id:"adapter",qty:2}]}],inventory)).toEqual([]);
  });
  it("breaks equal-price ties consistently when stored rows arrive in either order", () => {
    const a = { product_id: 1172744, daily_price: 20, total_three_days: 60 };
    const b = { product_id: 1115113, daily_price: 20, total_three_days: 50 };
    for (const rows of [[a, b], [b, a]]) expect(chooseBaseListing(rows, [a.product_id, b.product_id])?.total_three_days).toBe(50);
  });
  it("includes standard bundled cards without losing the real camera rate", () => expect(ids([{ item_id: "body", qty: 1 }, { item_id: "card", qty: 1 }])).toEqual([1]));
  it("does not price a camera from a body/lens bundle", () => expect(ids([{ item_id: "body", qty: 1 }, { item_id: "lens", qty: 1 }])).toEqual([]));
  it("does not use a two-body set as a single camera rate", () => expect(ids([{ item_id: "body", qty: 2 }])).toEqual([]));
  it("empty marketing mappings override a stale index", () => expect(ids([])).toEqual([]));
  it("does not price a bundled card from its camera listing", () => expect(ids([{ item_id: "body", qty: 1 }, { item_id: "card", qty: 1 }], "card")).toEqual([]));
  it("unknown extra components cannot authorize a base rate", () => expect(ids([{ item_id: "body", qty: 1 }, { item_id: "unknown", qty: 1 }])).toEqual([]));
  it("includes an override-only listing and isolates accounts", () => {
    expect(baseListingProductIds("leo", "body", [], [{ account_slug: "leo", product_id: 2, components: [{ item_id: "body", qty: 1 }] }, { account_slug: "diogo", product_id: 3, components: [{ item_id: "body", qty: 1 }] }], items)).toEqual([2]);
  });
});


describe("lens offering contents distinguish packaging from tracked extras",()=>{
 const lens={_id:"gm",name_canonical:"Sony GM 16-35mm f2.8",kind:"lens",lens_mount:"Sony E-mount"};
 const inventory=[lens,{_id:"nd",name_canonical:"ND filter",kind:"accessory"}];
 const mapping=[{account_slug:"leo",product_id:1115113,components:[{item_id:"gm",qty:1}]}];
 it("keeps the actual single-lens listing price despite front/rear caps and hood",()=>{
  const description="Included in this rental: • Sony FE 16–35mm f/2.8 GM Lens • Front and Rear Lens Caps • Lens Hood • Carry Pouch About this item: Sony wide-angle zoom.";
  expect(baseListingProductIds("leo","gm",[],mapping,inventory,[{product_id:1115113,description}])).toEqual([1115113]);
 });
 it("does not hide a separately tracked filter, extra lens or mixed equipment behind packaging",()=>{
  for(const extra of ["ND filter","Sony 24-70mm lens","Lens Hood with Sony 24-70mm lens"]){
   const description=`Included in this rental: • Sony 16-35mm GM f2.8 lens • ${extra}`;
   expect(baseListingProductIds("leo","gm",[],mapping,inventory,[{product_id:1115113,description}])).toEqual([]);
  }
 });
});
