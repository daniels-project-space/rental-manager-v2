import { describe, it, expect } from "vitest";
import { baseListingProductIds, chooseBaseListing } from "./base_listing_identity";
const items = [{ _id: "body", name_canonical: "Sony FX3", kind: "camera" }, { _id: "card", name_canonical: "CFexpress card", kind: "storage_card" }, { _id: "lens", name_canonical: "Sony 24-70mm", kind: "lens" }];
const index = [{ account_slug: "leo", product_id: 1, item_id: "body" }];
const ids = (components: Array<{ item_id: string; qty: number }>, target = "body") => baseListingProductIds("leo", target, index, [{ account_slug: "leo", product_id: 1, components }], items);
describe("base listing identity", () => {
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
