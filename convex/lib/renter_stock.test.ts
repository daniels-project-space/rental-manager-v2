import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { evaluateStockWindow, stockForItem, stockWindowPeak, validIsoDate } from "./renter_stock";

const request = { item_name: "Sony FX3", start_date: "2026-10-02", end_date: "2026-10-04" };
const evaluate = (overrides: Partial<Parameters<typeof evaluateStockWindow>[0]> = {}) => evaluateStockWindow({ request, owned: true, total: 4, repair: 0, occupancy: [], blackouts: [], vacations: [], ...overrides });
const hire = (qty: number, renter_name = "A") => ({ start: "2026-10-02T00:00", end: "2026-10-05T00:00", qty, renter_name });

describe("renter stock verdicts", () => {
  it("never rents marketing or inactive stock even with no competing bookings", () => {
    expect(evaluate({ owned: false }).available).toBe(false);
    expect(evaluate({ owned: false }).reason).toBe("not_rentable");
  });
  it("allows remaining units when another rental overlaps", () => {
    expect(evaluate({ occupancy: [hire(1)] }).free_units).toBe(3);
    expect(evaluate({ occupancy: [hire(1)] }).available).toBe(true);
  });
  it("checks the quantity the renter requests rather than any free unit", () => {
    expect(evaluate({ occupancy: [hire(3)], request: { ...request, quantity: 2 } }).available).toBe(false);
  });
  it("deducts multi-unit bookings and independent renters", () => {
    expect(evaluate({ occupancy: [hire(2), hire(1, "B")] }).free_units).toBe(1);
  });
  it("counts a proven matching-basket extension once", () => {
    expect(evaluate({ occupancy: [{ ...hire(2), extension_key: "same-basket" }, { ...hire(2), extension_key: "same-basket" }] }).free_units).toBe(2);
  });
  it("does not merge occupancy by renter name alone", () => {
    expect(evaluate({ occupancy: [hire(1), hire(2)] }).free_units).toBe(1);
  });
  it("does not total rentals that do not overlap each other", () => {
    const occupancy = [{ ...hire(3), end: "2026-10-03T00:00" }, { ...hire(3, "B"), start: "2026-10-03T00:00" }];
    expect(evaluate({ occupancy }).free_units).toBe(1);
  });
  it("checks every day including a later conflict", () => {
    expect(evaluate({ occupancy: [{ ...hire(4), start: "2026-10-04T00:00" }] }).available).toBe(false);
  });
  it("deducts repairs", () => {
    expect(evaluate({ repair: 3, occupancy: [hire(1)] }).available).toBe(false);
  });
  it("honors item blackouts and global vacations", () => {
    expect(evaluate({ blackouts: [{ start_date: "2026-10-03", end_date: "2026-10-03" }] }).reason).toBe("owner_blocked");
    expect(evaluate({ vacations: [{ start_date: "2026-10-04", end_date: "2026-10-06" }] }).reason).toBe("owner_away");
  });
  it("allows a same-day handover only after the actual buffered return", () => {
    const occupancy = [{ ...hire(1), end: "2026-10-02T12:00" }];
    expect(evaluate({ total: 1, occupancy, request: { ...request, pickup_time: "11:59" } }).available).toBe(false);
    expect(evaluate({ total: 1, occupancy, request: { ...request, pickup_time: "12:00" } }).available).toBe(true);
  });
  it("does not count a booking outside the requested window", () => {
    expect(evaluate({ occupancy: [{ ...hire(4), start: "2026-10-05T00:00", end: "2026-10-06T00:00" }] }).available).toBe(true);
  });
  it.each(["2026-02-30", "2026-13-01", "tomorrow", "2026-10-2"])("rejects invalid date %s rather than claiming free", (date) => {
    expect(validIsoDate(date)).toBe(false);
    expect(evaluate({ request: { ...request, start_date: date } }).available).toBeNull();
  });
  it("rejects reversed, excessively long and invalid-time windows", () => {
    expect(evaluate({ request: { ...request, end_date: "2026-10-01" } }).available).toBeNull();
    expect(evaluate({ request: { ...request, end_date: "2028-01-01" } }).available).toBeNull();
    expect(evaluate({ request: { ...request, pickup_time: "25:00" } }).available).toBeNull();
  });
  it("never implies available when requested stock quantity is invalid", () => {
    expect(evaluate({ request: { ...request, quantity: 0 } }).available).toBeNull();
    expect(evaluate({ request: { ...request, quantity: 1.5 } }).available).toBeNull();
  });
  it("has no arbitrary calendar horizon that can hide later bookings", () => {
    expect(evaluate({ request: { ...request, end_date: "2027-01-01" }, occupancy: [{ ...hire(4), start: "2026-12-01T00:00", end: "2026-12-02T00:00" }] }).available).toBe(false);
  });
  it("reports no competing renter identity in the tool result", () => {
    expect(JSON.stringify(evaluate({ occupancy: [hire(1, "Private customer")] }))).not.toContain("Private customer");
  });
  it("does not merge unnamed renters", () => {
    expect(stockWindowPeak([{ ...hire(1), renter_name: undefined }, { ...hire(1), renter_name: undefined }], "2026-10-02T00:00", "2026-10-03T00:00")).toBe(2);
  });
});

describe("shared kit stock across separate reservations", () => {
  const pool = {_id:"b",name_canonical:"NP-F570 batteries",kind:"power",unit_kind:"unit",track_independent_stock:true,status:"active",qty:12};
  const camera = (id:string) => ({_id:id,name_canonical:id,kind:"camera",supplied_stock:[{item_id:"b",qty:5,source:"kit"}]});
  const items = [camera("pro"),camera("ff"),pool];
  const reservation = (order:string,product:number,extra={}) => ({hygglo_order_id:order,account_slug:"leo",renter_name:"Same Renter",status:"confirmed",start_date:"2026-10-20",end_date:"2026-10-21",hygglo_items:[{product_id:product}],...extra});
  const check = (reservations:any[]) => stockForItem({items,reservations,productIndex:new Map(),overrides:new Map([["leo#1",[{item_id:"pro",qty:1}]],["leo#2",[{item_id:"ff",qty:1}]]]),claims:[],blackouts:[],vacations:[]} as any,pool as any,{item_name:pool.name_canonical,start_date:"2026-10-20",end_date:"2026-10-21",quantity:3});
  it("counts five batteries in each different kit for the same renter",()=>{
    const result=check([reservation("pro-order",1),reservation("ff-order",2)]);
    expect(result.free_units).toBe(2);
    expect(result.available).toBe(false);
    expect(result.per_day.map(d=>d.booked)).toEqual([10,10]);
  });
  it("preserves matching kit extensions with normalized names",()=>{
    expect(check([reservation("original",1),reservation("extension",1,{renter_name:" SAME   RENTER "})]).free_units).toBe(7);
  });
  it("counts different renter IDs separately even when names match",()=>{
    expect(check([reservation("a",1,{renter_id:"person-a"}),reservation("b",1,{renter_id:"person-b"})]).free_units).toBe(2);
  });
  it("does not merge unknown renters or changed basket quantities",()=>{
    expect(check([reservation("a",1,{renter_name:"Unknown"}),reservation("b",1,{renter_name:"Unknown"})]).free_units).toBe(2);
    expect(check([reservation("a",1),reservation("b",1,{hygglo_items:[{product_id:1,qty:2}]})]).free_units).toBe(0);
  });
});

describe("website physical allocation dates in real quoting",()=>{
 it("quotes the gap as free and each separate extension as three bodies",()=>{
  const item={_id:"camera",name_canonical:"FX3",status:"active",qty:3};
  const day=(n:number)=>Date.UTC(2035,0,n);
  const sources={items:[item],productIndex:new Map(),overrides:new Map(),claims:[],blackouts:[],vacations:[],reservations:[{account_slug:"dbcinema_web",hygglo_order_id:"web",status:"confirmed",start_date:"2035-01-01",end_date:"2035-01-05",site_item_windows:[{item_id:"camera",qty:3,start:day(1),end:day(2)},{item_id:"camera",qty:3,start:day(4),end:day(5)}]}]};
  const quote=(date:string)=>stockForItem(sources as any,item as any,{item_name:"FX3",start_date:date,end_date:date});
  expect(quote("2035-01-01").free_units).toBe(0);expect(quote("2035-01-03").free_units).toBe(3);expect(quote("2035-01-04").free_units).toBe(0);
  expect(stockForItem(sources as any,item as any,{item_name:"FX3",start_date:"2035-01-01",end_date:"2035-01-05",thread_id:"web"}).free_units).toBe(3);
 });
});


describe("saved website clocks in actual quoting",()=>{
 const item={_id:"camera",name_canonical:"FX3",status:"active",qty:1};
 const window={item_id:"camera",qty:1,start:Date.UTC(2035,0,1),end:Date.UTC(2035,0,2),pickupTime:"09:00",returnTime:"12:00"};
 const quote=(saved:any,start_date:string,pickup_time:string,return_time?:string)=>{
  const reservation={account_slug:"dbcinema_web",hygglo_order_id:"web",status:"confirmed",start_date:"2035-01-01",end_date:"2035-01-02",pickup_time:"06:00",return_time:"22:00",site_item_windows:[saved]};
  const sources={items:[item],productIndex:new Map(),overrides:new Map(),claims:[],blackouts:[],vacations:[],reservations:[reservation]};
  return stockForItem(sources as any,item as any,{item_name:"FX3",start_date,end_date:start_date,pickup_time,return_time});
 };
 it("allows the next handover only after the saved window's buffered return",()=>{
  expect(quote(window,"2035-01-02","12:59").available).toBe(false);
  expect(quote(window,"2035-01-02","13:00").available).toBe(true);
 });
 it("uses the saved pickup instead of an unrelated booking clock",()=>{
  expect(quote(window,"2035-01-01","07:00","08:59").available).toBe(true);
  expect(quote(window,"2035-01-01","08:00","09:01").available).toBe(false);
 });
 it("keeps an explicitly undefined return unavailable for its whole return day",()=>{
  expect(quote({...window,returnTime:null},"2035-01-02","23:59").available).toBe(false);
  expect(quote({...window,returnTime:null},"2035-01-03","00:00").available).toBe(true);
 });
 it("inherits booking clocks only for older windows without those fields",()=>{
  const {pickupTime,returnTime,...legacy}=window;
  expect(quote(legacy,"2035-01-02","13:00").available).toBe(false);
  expect(quote(legacy,"2035-01-02","23:00").available).toBe(true);
 });
 it("carries late buffered returns into the next day",()=>{
  expect(quote({...window,returnTime:"23:30"},"2035-01-03","00:29").available).toBe(false);
  expect(quote({...window,returnTime:"23:30"},"2035-01-03","00:30").available).toBe(true);
 });
});

describe("booked-period availability and separate custody",()=>{
 beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));});
 afterEach(()=>vi.useRealTimers());
 const item={_id:"camera",name_canonical:"FX3",status:"active",qty:3};
 const hire={account_slug:"leo",hygglo_order_id:"out",status:"confirmed",order_step:"DELIVERED",start_date:"2026-08-01",end_date:"2026-08-02",return_time:"12:00",resolved_items:[{item_id:"camera",qty:2}]};
 const quote=(reservation:any,extra={})=>stockForItem({items:[item],reservations:[reservation],productIndex:new Map(),overrides:new Map(),claims:[],blackouts:[],vacations:[]} as any,item as any,{item_name:"FX3",start_date:"2027-01-01",end_date:"2027-01-02",quantity:2,...extra});
 it("restores forecast availability after the agreed period without recording a return",()=>{
  const saved=JSON.stringify(hire);
  const result=quote(hire);
  expect(result.available).toBe(true);expect(result.free_units).toBe(3);
  expect(result.per_day.map(d=>d.booked)).toEqual([0,0]);
  expect(JSON.stringify(hire)).toBe(saved);
  expect(quote({...hire,status:"ongoing"}).free_units).toBe(3);
  expect(quote(hire,{start_date:"2026-08-01",end_date:"2026-08-02"}).free_units).toBe(1);
  expect(quote({...hire,order_step:"RETURNED"},{start_date:"2026-08-01",end_date:"2026-08-02"}).free_units).toBe(1);
 });
 it("releases recorded returns and excludes obsolete copies",()=>{
  expect(quote({...hire,order_step:"REVIEWED"},{start_date:"2026-08-01",end_date:"2026-08-02"}).free_units).toBe(3);
  expect(quote({...hire,is_obsolete:true}).free_units).toBe(3);
 });
 it("preserves planned future handovers and request identity",()=>{
  expect(quote({...hire,start_date:"2026-10-20",end_date:"2026-10-21"}).free_units).toBe(3);
  expect(quote(hire,{thread_id:"out"}).free_units).toBe(3);
  expect(quote(hire,{end_date:"tomorrow"}).available).toBeNull();
 });
 it("keeps independent website allocation dates without forecast extensions",()=>{
  const reservation={...hire,account_slug:"dbcinema_web",site_item_windows:[
   {item_id:"camera",qty:2,start:Date.UTC(2026,7,1),end:Date.UTC(2026,7,2),returnTime:"12:00"},
   {item_id:"camera",qty:2,start:Date.UTC(2026,7,3),end:Date.UTC(2026,7,4),returnTime:"12:00"},
  ]};
  const saved=JSON.stringify(reservation);const result=quote(reservation);
  expect(result.free_units).toBe(3);expect(result.per_day.map(d=>d.booked)).toEqual([0,0]);
  expect(JSON.stringify(reservation)).toBe(saved);
 });
});
