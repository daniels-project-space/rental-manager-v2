import { describe, expect, it } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import { resolveListingComponents, listingStock } from "./listing_inventory";
import type { loadStockSources } from "./renter_stock";
import { stockForRentalItem } from "./renter_stock";

const inventory = [
  { _id: "camera", name_canonical: "Sony FX3", kind: "camera", status: "active", qty: 4 },
  { _id: "lens", name_canonical: "Sony GM 24-70mm f2.8", kind: "lens", status: "active", qty: 2 },
  { _id: "card", name_canonical: "CF Express Type A card", kind: "storage_card", status: "active", qty: 1 },
  { _id: "marketing", name_canonical: "RED Komodo", kind: "camera", status: "active", qty: 1, is_marketing_only: true },
] as unknown as Doc<"items">[];
const kit = [{ item_id: "camera", qty: 2 }, { item_id: "lens", qty: 2 }];
const request = { item_name: "Two camera kit", start_date: "2026-10-02", end_date: "2026-10-04", quantity: 1 };
const resolution = (override: typeof kit | undefined = kit, quantity = 1) => ({ ...resolveListingComponents(inventory, override, "lens", quantity), product_id: 1172559, listing_name: "Two camera kit" });
const sources = (extra: Partial<Awaited<ReturnType<typeof loadStockSources>>> = {}) => ({
  items: inventory, reservations: [], productIndex: new Map(), overrides: new Map(), claims: [], blackouts: [], vacations: [], ...extra,
});

describe("whole listing inventory and stock", () => {
  it("checks the supplied camera adapter against other confirmed camera hires",()=>{
    const native=[{_id:"ff",name_canonical:"BMPCC 6K Full Frame",kind:"camera",status:"active",qty:2,compatibility:{included_with_rental:["EF to L mount adapter"]}},{_id:"adapter",name_canonical:"EF to L mount",aliases:["EF to L mount adapter"],kind:"adapter",status:"active",qty:1}] as unknown as Doc<"items">[];
    const listing={...resolveListingComponents(native,[{item_id:"ff",qty:1}],"ff"),product_id:10,listing_name:"Full Frame kit"};
    expect(listing.components.find(c=>c.item_id==="adapter")).toMatchObject({requested_units:1,stock_required:true});
    const hire={status:"confirmed",start_date:request.start_date,end_date:request.end_date,expanded_items:[{item_id:"ff",qty:1}]} as unknown as Doc<"reservations">;
    const result=listingStock({...sources(),items:native,reservations:[hire]},listing,request);
    expect(result.available).toBe(false);
    expect(result.components.find(c=>c.item_name==="EF to L mount")).toMatchObject({free_units:0,available:false});
    expect(result.components.find(c=>c.item_name==="BMPCC 6K Full Frame")).toMatchObject({free_units:1,available:true});
    const offered=stockForRentalItem({...sources(),items:native,reservations:[hire]},native[0],{item_name:native[0].name_canonical,start_date:request.start_date,end_date:request.end_date});
    expect(offered).toMatchObject({available:false,free_units:0,total_units:1});
    expect(offered.per_day.every(d=>d.free===0)).toBe(true);
  });
  it("keeps unknown recorded adapters unverified rather than silently dropping them",()=>{
    const native=[{...inventory[0],compatibility:{included_with_rental:["Unknown EF to L mount adapter"]}}] as Doc<"items">[];
    expect(resolveListingComponents(native,[{item_id:"camera",qty:1}],"camera")).toMatchObject({complete:false,owned:null});
  });
  it("cannot prove a multi-item listing from its primary lens", () => {
    const listing = { ...resolveListingComponents(inventory, undefined, "lens"), product_id: 1172559, listing_name: "Two camera kit" };
    expect(listing.owned).toBeNull();
    expect(listingStock(sources(), listing, request).available).toBeNull();
  });
  it("requires both cameras even when both lenses are free", () => {
    const cameraHire = { start_date: request.start_date, end_date: request.end_date, status: "confirmed", renter_name: "A", expanded_items: [{ item_id: "camera", qty: 3 }] } as unknown as Doc<"reservations">;
    const result = listingStock(sources({ reservations: [cameraHire] }), resolution(), request);
    expect(result.available).toBe(false);
    expect(result.free_units).toBe(0);
    expect(result.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ item_name: "Sony FX3", requested_units: 2, available: false, free_units: 1 }),
      expect.objectContaining({ item_name: "Sony GM 24-70mm f2.8", requested_units: 2, available: true }),
    ]));
  });
  it("requires every independent lens as well as the camera", () => {
    const result = listingStock(sources({ blackouts: [{ item_id: "lens" as Id<"items">, start_date: request.start_date, end_date: request.end_date }] as Awaited<ReturnType<typeof loadStockSources>>["blackouts"] }), resolution(), request);
    expect(result.available).toBe(false);
    expect(result.components.find((c) => c.item_name === "Sony FX3")?.available).toBe(true);
  });
  it("multiplies components by requested kit count and sums repeated components", () => {
    const listing = resolution([{ item_id: "camera", qty: 1 }, { item_id: "camera", qty: 1 }, { item_id: "lens", qty: 1 }], 2);
    expect(listing.components.find((c) => c.item_id === "camera")?.requested_units).toBe(4);
    expect(listingStock(sources(), listing, { ...request, quantity: 2 }).available).toBe(true);
  });
  it("does not create an independent stock limit for standard bundled cards", () => {
    const listing = resolution([...kit, { item_id: "card", qty: 4 }]);
    expect(listingStock(sources(), listing, request).available).toBe(true);
    expect(listingStock(sources(), listing, request).components).toHaveLength(2);
  });
  it("never offers a kit with a marketing component", () => {
    expect(listingStock(sources(), resolution([...kit, { item_id: "marketing", qty: 1 }]), request).available).toBe(false);
  });
  it("an explicit empty marketing override wins over an owned primary item", () => {
    expect(resolution([]).owned).toBe(false);
    expect(listingStock(sources(), resolution([]), request).available).toBe(false);
  });
  it("an unmapped component leaves the full kit unverified", () => {
    expect(listingStock(sources(), resolution([...kit, { item_id: "missing", qty: 1 }]), request).available).toBeNull();
  });
  it.each([0, 1.5, 21])("rejects invalid kit quantity %s", (quantity) => {
    expect(listingStock(sources(), resolution(kit, quantity), { ...request, quantity }).available).toBeNull();
  });
  it("keeps independent dated quantity receipts for operator review", () => {
    const result = listingStock(sources(), resolution(), request);
    expect(result.available).toBe(true);
    expect(result.components).toHaveLength(2);
    for (const c of result.components) expect(c).toMatchObject({ owned: true, start_date: request.start_date, end_date: request.end_date, requested_units: 2, checked_at: expect.any(Number) });
  });
});


describe("declared kit coverage", () => {
  const desc="Included in this rental: • 1x Sony FX3 • 1x Sony GM 24-70mm f2.8";
  it("does not prove a whole kit from a valid body-only override", () => {
    const listing={...resolveListingComponents(inventory,[{item_id:"camera",qty:1}],undefined,1,desc),product_id:1,listing_name:"FX3 kit"};
    expect(listing.complete).toBe(false);expect(listing.owned).toBeNull();
    expect(listing.coverage?.missing).toEqual([{item_id:"lens",name:"Sony GM 24-70mm f2.8",qty:1}]);
    expect(listingStock(sources(),listing,request).available).toBeNull();
  });
  it("accepts the full identity mapping and still checks the lens stock", () => {
    const listing={...resolveListingComponents(inventory,[{item_id:"camera",qty:1},{item_id:"lens",qty:1}],undefined,1,desc),product_id:1,listing_name:"FX3 kit"};
    expect(listing.complete).toBe(true);expect(listingStock(sources(),listing,request).available).toBe(true);
  });
  it("keeps unfamiliar required equipment unresolved rather than ignoring it", () => {
    const listing=resolveListingComponents(inventory,[{item_id:"camera",qty:1}],undefined,1,"Included in this kit: • 1x Sony FX3 • 1x Mystery cinema lens");
    expect(listing.complete).toBe(false);expect(listing.coverage?.unresolved).toHaveLength(1);
  });
});
