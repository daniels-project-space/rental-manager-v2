import { describe, expect, it } from "vitest";
import {websiteWindowUnits,websiteCalendarPeriods, websiteDayIntervals, reservationItemUnits, type OverrideMap } from "./itemUnits";
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


it("sums shared supplied batteries and separately booked extras across logical listings",()=>{
 const inventory=[{_id:"pro",name_canonical:"Pro",kind:"camera",supplied_stock:[{item_id:"b",qty:5,source:"kit"}]},{_id:"ff",name_canonical:"Full Frame",kind:"camera",supplied_stock:[{item_id:"b",qty:5,source:"kit"}]},{_id:"b",name_canonical:"NP-F570 batteries",kind:"power",unit_kind:"unit",track_independent_stock:true}];
 const mapping:OverrideMap=new Map([["leo#1",[{item_id:"pro",qty:1},{item_id:"b",qty:5}]],["leo#2",[{item_id:"ff",qty:1}]],["leo#3",[{item_id:"b",qty:3}]]]);
 expect(reservationItemUnits({account_slug:"leo",hygglo_items:[{product_id:1},{product_id:2},{product_id:3}]},new Map(),mapping,inventory).get("b")).toBe(13);
});

describe("website item calendar intervals",()=>{
 const day=(n:number)=>Date.UTC(2035,0,n);
 const r={site_item_windows:[{item_id:"camera",qty:3,start:day(1),end:day(2)},{item_id:"camera",qty:3,start:day(4),end:day(5)}],pickup_time:"10:00",return_time:"17:00"};
 it("leaves the gap free and includes turnaround after the agreed return on the actual item date",()=>{
  expect(websiteDayIntervals(r,"2035-01-03")).toEqual([]);
  expect(websiteDayIntervals(r,"2035-01-01")).toEqual([{id:"camera",a:"10:00",b:"24:00",qty:3}]);
  expect(websiteDayIntervals(r,"2035-01-02")).toEqual([{id:"camera",a:"00:00",b:"18:00",qty:3}]);
 });
 it("carries one hour after a late return into the next day",()=>{
  expect(websiteDayIntervals({...r,return_time:"23:30"},"2035-01-03")).toEqual([{id:"camera",a:"00:00",b:"00:30",qty:3}]);
 });
});

describe("saved website per-item clocks", () => {
  const start = Date.UTC(2035, 0, 1), end = Date.UTC(2035, 0, 2);
  const base = {pickup_time:"10:00",return_time:"19:00"};
  it("releases separate items after their own agreed return plus one hour", () => {
    const site_item_windows = [{item_id:"camera",qty:1,start,end,returnTime:"12:00"},{item_id:"lens",qty:2,start,end,returnTime:"19:00"}];
    expect(websiteDayIntervals({...base,site_item_windows},"2035-01-02")).toEqual([{id:"camera",a:"00:00",b:"13:00",qty:1},{id:"lens",a:"00:00",b:"20:00",qty:2}]);
  });
  it("keeps explicitly unagreed slots for the whole day rather than inheriting another item", () => {
    expect(websiteDayIntervals({...base,site_item_windows:[{item_id:"camera",qty:1,start,end,returnTime:null}]},"2035-01-02")).toEqual([{id:"camera",a:"00:00",b:"24:00",qty:1}]);
  });
  it("uses per-window pickup clocks and preserves legacy fallback", () => {
    expect(websiteDayIntervals({...base,site_item_windows:[{item_id:"camera",qty:1,start,end,pickupTime:"12:00"}]},"2035-01-01")[0].a).toBe("12:00");
    expect(websiteDayIntervals({...base,site_item_windows:[{item_id:"camera",qty:1,start,end}]},"2035-01-02")[0].b).toBe("20:00");
  });
  it("carries one hour after an individual late return into the following day", () => {
    expect(websiteDayIntervals({...base,site_item_windows:[{item_id:"camera",qty:1,start,end,returnTime:"23:30"}]},"2035-01-03")).toEqual([{id:"camera",a:"00:00",b:"00:30",qty:1}]);
  });
});

it('scales and aggregates partial audited kit quantities without overwriting another mapped listing',()=>{
 const mapping:OverrideMap=new Map([['leo#10',[{item_id:'camera',qty:2}]],['leo#11',[{item_id:'camera',qty:1}]]]);
 const res={account_slug:'leo',expanded_items:[{item_id:'camera',qty:99},{item_id:'lens',qty:3}],hygglo_items:[{product_id:10,qty:2},{product_id:11,qty:2},{product_id:12,name:'Lens',qty:3}]};
 expect(reservationItemUnits(res,new Map([['leo#12','lens']]),mapping).get('camera')).toBe(6);
 expect(reservationItemUnits({...res,hygglo_items:[...res.hygglo_items,{product_id:13,name:'2x camera bodies',qty:2}]},new Map([['leo#12','lens'],['leo#13','camera']]),mapping).get('camera')).toBe(10);
 expect(reservationItemUnits({...res,hygglo_items:[...res.hygglo_items].reverse()},new Map([['leo#12','lens']]),mapping).get('camera')).toBe(6);
 expect(reservationItemUnits(res,new Map([['leo#12','lens']]),mapping).get('lens')).toBe(3);
});

it('keeps supplied and separately booked adapter quantities in partial audits',()=>{
 const inventory=[{_id:'ff',name_canonical:'BMPCC 6K Full Frame',kind:'camera',compatibility:{included_with_rental:['EF to L mount adapter']}},{_id:'adapter',name_canonical:'EF to L mount',aliases:['EF to L mount adapter'],kind:'adapter'}];
 const mapping:OverrideMap=new Map([['leo#10',[{item_id:'ff',qty:1}]]]);
 const units=reservationItemUnits({account_slug:'leo',expanded_items:[{item_id:'ff',qty:1},{item_id:'adapter',qty:1}],hygglo_items:[{product_id:10,qty:2},{product_id:12,name:'EF to L mount adapter',qty:1}]},new Map([['leo#12','adapter']]),mapping,inventory);
 expect(Object.fromEntries(units)).toEqual({ff:2,adapter:3});
});
it('refuses malformed booked/audited quantities before multiplication can hide them',()=>{
 for(const qty of [0,-1,0.5,NaN])for(const partial of [false,true])expect(()=>reservationItemUnits({account_slug:'leo',hygglo_items:[{product_id:10,qty},...(partial?[{product_id:12}]:[])]},new Map(),new Map([['leo#10',[{item_id:'camera',qty:2}]]]))).toThrow('Invalid reserved listing quantity');
 for(const qty of [0,-1,0.5,NaN])expect(()=>reservationItemUnits({account_slug:'leo',hygglo_items:[{product_id:10,qty:2}]},new Map(),new Map([['leo#10',[{item_id:'camera',qty}]]]))).toThrow('Invalid audited kit quantity');
});
it('refuses overflowing multiplied or accumulated physical quantities',()=>{
 const mapping:OverrideMap=new Map([['leo#10',[{item_id:'camera',qty:Number.MAX_SAFE_INTEGER}]]]);
 expect(()=>reservationItemUnits({account_slug:'leo',hygglo_items:[{product_id:10,qty:2}]},new Map(),mapping)).toThrow('Invalid reserved unit quantity');
 expect(()=>reservationItemUnits({account_slug:'leo',hygglo_items:[{product_id:10},{product_id:10}]},new Map(),mapping)).toThrow('Invalid reserved unit quantity');
});

describe("exact website UTC allocation projection",()=>{
 const first={item_id:"body",qty:1,start:Date.UTC(2026,9,9,8),end:Date.UTC(2026,9,9,12),pickupTime:"09:00",returnTime:"12:00",endExclusive:true,stockWindowVersion:2,turnaroundBufferMinutes:60};
 const second={...first,start:Date.UTC(2026,9,9,12),end:Date.UTC(2026,9,9,18),pickupTime:"13:00",returnTime:"18:00"};
 it("keeps same-day adjacent hires at one physical unit",()=>expect(websiteWindowUnits([first,second],"2026-10-09").get("body")).toBe(1));
 it("uses marked occupied end without adding the turnaround twice",()=>expect(websiteDayIntervals({account_slug:"dbcinema_web",site_item_windows:[first]},"2026-10-09")).toEqual([{id:"body",a:"09:00",b:"13:00",qty:1}]));
 it("preserves actual displayed return clock and date separately from occupied turnaround",()=>{const p=websiteCalendarPeriods({account_slug:"dbcinema_web",end_date:"2026-10-09",return_time:"12:00",site_item_windows:[first]})[0];expect(p.return_time).toBe("12:00");expect(p.end_date).toBe("2026-10-09");});
 it("shows an unknown midnight-exclusive return on its occupied final day",()=>{const w={...first,returnTime:null,end:Date.UTC(2026,9,10,0)};expect(websiteCalendarPeriods({account_slug:"dbcinema_web",end_date:"2026-10-09",site_item_windows:[w]})[0].end_date).toBe("2026-10-09");expect(websiteWindowUnits([w],"2026-10-10").get("body")).toBe(1);});
});

describe("legacy calendar elapsed turnaround across London DST",()=>{
 const window=(date:string)=>({item_id:"body",qty:1,start:Date.parse(date+"T00:00Z"),end:Date.parse(date+"T00:00Z")});
 it("shows02:30 after an actual00:30 spring return plus one elapsed hour",()=>expect(websiteDayIntervals({site_item_windows:[window("2026-03-29")],pickup_time:"00:00",return_time:"00:30"},"2026-03-29")).toEqual([{id:"body",a:"00:00",b:"02:30",qty:1}]));
 it("uses the later ambiguous autumn return before adding one elapsed hour",()=>expect(websiteDayIntervals({site_item_windows:[window("2026-10-25")],pickup_time:"00:00",return_time:"01:30"},"2026-10-25")).toEqual([{id:"body",a:"00:00",b:"02:30",qty:1}]));
 it("carries an unknown full-day spring boundary through the clock jump conservatively",()=>expect(websiteDayIntervals({site_item_windows:[window("2026-03-28")]},"2026-03-29")).toEqual([{id:"body",a:"00:00",b:"02:00",qty:1}]));
});

 it("uses signed display dates without narrowing conservative occupied UTC bounds",()=>{const w={item_id:"body",qty:1,start:Date.UTC(2026,9,8,23),end:Date.UTC(2026,9,11,0),pickupDate:"2026-10-09",returnDate:"2026-10-10",pickupTime:"09:00",returnTime:"18:00",endExclusive:true,stockWindowVersion:2,turnaroundBufferMinutes:60};const p=websiteCalendarPeriods({account_slug:"dbcinema_web",start_date:"2026-10-09",end_date:"2026-10-10",return_time:"18:00",site_item_windows:[w]})[0];expect(p.start_date).toBe("2026-10-09");expect(p.end_date).toBe("2026-10-10");expect(p.return_time).toBe("18:00");expect(websiteDayIntervals({site_item_windows:[w]},"2026-10-11")).toEqual([{id:"body",a:"00:00",b:"01:00",qty:1}]);});
