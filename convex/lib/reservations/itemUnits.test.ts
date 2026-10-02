import { describe, expect, it } from "vitest";
import { reservationItemUnits, type OverrideMap } from "./itemUnits";
import { withDefaultAdapters } from "../default_adapter_units";
const overrides: OverrideMap = new Map([
  ["leo#1", [{ item_id: "camera", qty: 2 }, { item_id: "lens", qty: 2 }]],
  ["leo#2", [{ item_id: "gopro", qty: 3 }]],
]);
describe("held units from fully mapped listing quantities", () => {
  const camera={_id:"ff",name_canonical:"BMPCC 6K Full Frame",kind:"camera",compatibility:{included_with_rental:["EF to L mount adapter"]}};
  const adapter={_id:"adapter",name_canonical:"EF to L mount",aliases:["EF to L mount adapter"],kind:"adapter"};
  const inventory=[camera,adapter];
  it("counts supplied adapters per kit and extra adapters on separate reserved lines",()=>{
    const mapping:OverrideMap=new Map([["leo#10",[{item_id:"ff",qty:1}]],["leo#11",[{item_id:"adapter",qty:1}]]]);
    const units=reservationItemUnits({account_slug:"leo",hygglo_items:[{product_id:10,qty:2},{product_id:11}]},new Map(),mapping,inventory);
    expect(Object.fromEntries(units)).toEqual({ff:2,adapter:3});
  });
  it("does not double-count an explicitly mapped supplied adapter",()=>{
    expect(withDefaultAdapters([{item_id:"ff",qty:1},{item_id:"adapter",qty:1}],inventory).components).toEqual([{item_id:"ff",qty:1},{item_id:"adapter",qty:1}]);
    expect(withDefaultAdapters([{item_id:"ff",qty:2},{item_id:"adapter",qty:1}],inventory).components.find(c=>c.item_id==="adapter")?.qty).toBe(2);
  });
  it("reserves a supplied adapter for legacy resolved camera rows too",()=>{
    expect(reservationItemUnits({expanded_items:[{item_id:"ff",qty:1}]},new Map(),undefined,inventory).get("adapter")).toBe(1);
  });
  it("does not infer a compatible mount as a supplied adapter or allocate marketing gear",()=>{
    expect(withDefaultAdapters([{item_id:"ff",qty:1}],[{...camera,compatibility:undefined},adapter]).components).toEqual([{item_id:"ff",qty:1}]);
    expect(withDefaultAdapters([{item_id:"ff",qty:1}],[{...camera,is_marketing_only:true},adapter]).components).toEqual([{item_id:"ff",qty:1}]);
  });
  it("does not resolve an adapter back to the camera's own incidental alias",()=>{
    const malformed={...camera,aliases:["EF to L mount adapter"]};
    expect(withDefaultAdapters([{item_id:"ff",qty:1}],[malformed]).unresolved).toEqual(["EF to L mount adapter"]);
  });
  it("counts two reserved kits as four cameras and four lenses", () => {
    expect(Object.fromEntries(reservationItemUnits({ account_slug: "leo", hygglo_items: [{ product_id: 1, qty: 2 }] }, new Map(), overrides)))
      .toEqual({ camera: 4, lens: 4 });
  });
  it("does not multiply the title's built-in unit count a second time", () => {
    const units = reservationItemUnits({ account_slug: "leo", hygglo_items: [{ name: "3x GoPro set", product_id: 2 }] }, new Map(), overrides);
    expect(units.get("gopro")).toBe(3);
  });
  it("combines the same physical item across multiple reserved lines", () => {
    const units = reservationItemUnits({ account_slug: "leo", hygglo_items: [{ product_id: 1 }, { product_id: 1, qty: 2 }] }, new Map(), overrides);
    expect(units.get("camera")).toBe(6);
  });
  it("authoritative mappings replace a stale expanded primary lens", () => {
    const units = reservationItemUnits({ account_slug: "leo", expanded_items: [{ item_id: "wrong lens", qty: 1 }], hygglo_items: [{ product_id: 1, qty: 2 }] }, new Map(), overrides);
    expect(units.has("wrong lens")).toBe(false);
    expect(units.get("lens")).toBe(4);
  });
});
