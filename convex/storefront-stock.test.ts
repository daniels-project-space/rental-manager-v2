import {afterEach,describe,expect,it,vi} from "vitest";
vi.mock("./auth",()=>({authComponent:{registerRoutes:vi.fn(),safeGetAuthUser:vi.fn()},createAuth:vi.fn()}));
import {__service_sharedStockForStorefront as snapshot} from "./items";
import {storefrontRead} from "./http";
import {loadStockSources,stockForItem} from "./lib/renter_stock";
import {getFunctionName} from "convex/server";
const ms=(date:string)=>Date.parse(date+"Z");
function fixture(){
 const items:any[]=[{_id:"body",name_canonical:"Sony FX3",kind:"camera_body",status:"active",is_marketing_only:false,qty:3}];
 const tables:any={items,reservations:[],hygglo_product_index:[],listing_resolution_override:[],insurance_claims:[],owner_unavailability:[],vacation_periods:[]};
 const reads:string[]=[];const db:any={query:(table:string)=>{reads.push(table);let rows=tables[table]??[];const q:any={withIndex:(_:string,fn:any)=>{const s:any={eq:(k:string,v:any)=>{rows=rows.filter((r:any)=>r[k]===v);return s}};fn(s);return q},collect:async()=>rows};return q}};
 const rental=(extra:any={})=>({_id:"booking",_creationTime:1,account_slug:"other-owned-account",status:"confirmed",start_date:"2027-01-01",end_date:"2027-01-02",resolved_items:[{item_id:"body",qty:1}],...extra});
 const run=async()=>((snapshot as any)._handler({db},{})).then((rows:any)=>rows[0]);return {tables,db,reads,rental,run};
}
afterEach(()=>{vi.unstubAllEnvs();vi.useRealTimers()});
describe("actual private shared-stock snapshot",()=>{
 it("reads all shared accounts, omits local website mirrors and exposes only physical occupancy",async()=>{
  const f=fixture();f.tables.reservations=[f.rental({renter_name:"PRIVATE CUSTOMER",notes:"PRIVATE NOTE"}),f.rental({_id:"web",hygglo_order_id:"web",account_slug:"dbcinema_web"}),f.rental({_id:"returned",hygglo_order_id:"returned",order_step:"RETURNED"}),f.rental({_id:"cancelled",hygglo_order_id:"cancelled",status:"cancelled"}),f.rental({_id:"obsolete",hygglo_order_id:"obsolete",is_obsolete:true})];
  const result=await f.run();expect(f.reads).toEqual(["items","reservations","reservations","hygglo_product_index","listing_resolution_override","insurance_claims","owner_unavailability","vacation_periods"]);expect(result.units[0].windows).toEqual([{start:ms("2027-01-01T00:00"),end:ms("2027-01-03T00:00"),qty:1}]);expect(JSON.stringify(result)).not.toMatch(/PRIVATE|other-owned-account|booking|web|returned/);
 });
 it("matches real quoting for kit extensions and independently booked shared equipment",async()=>{
  const f=fixture();f.tables.reservations=[f.rental({hygglo_order_id:"first",renter_id:"renter"}),f.rental({_id:"extension",hygglo_order_id:"second",renter_id:"renter",start_date:"2027-01-02",end_date:"2027-01-03"}),f.rental({_id:"independent",hygglo_order_id:"third",renter_id:"different",start_date:"2027-01-02",end_date:"2027-01-02"})];
  const result=await f.run();expect(result.units[0].windows.map((w:any)=>w.qty)).toEqual([1,2,1]);const sources=await loadStockSources({db:f.db} as any),quote=stockForItem(sources,sources.items[0],{item_name:"Sony FX3",start_date:"2027-01-02",end_date:"2027-01-02"});expect(quote.free_units).toBe(1);expect(result.units[0].quantityOwned-Math.max(...result.units[0].windows.map((w:any)=>w.qty))).toBe(quote.free_units);
 });
 it("keeps ongoing overdue custody occupied until an actual return",async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-08"));const f=fixture();f.tables.reservations=[f.rental({status:"ongoing",order_step:"DELIVERED",start_date:"2026-08-01",end_date:"2026-08-02"})];let result=await f.run();expect(result.units[0].windows[0].end).toBe(ms("9999-12-31T00:00"));f.tables.reservations[0].order_step="RETURNED";result=await f.run();expect(result.units[0].windows).toEqual([]);
 });
 it("includes repair-held units, master-specific owner blocks and active vacations without private reasons",async()=>{
  const f=fixture();f.tables.insurance_claims=[{stage:"in_for_repair",status:"open",repair_item_ids:["body","body"],description:"PRIVATE CASE"},{stage:"added_to_revenue",status:"settled",repair_item_ids:["body"]}];f.tables.owner_unavailability=[{item_id:"body",start_date:"2027-01-01",end_date:"2027-01-02",reason:"PRIVATE REASON"},{item_id:"unrelated",start_date:"2027-02-01",end_date:"2027-02-02"}];f.tables.vacation_periods=[{is_active:true,start_date:"2027-03-01",end_date:"2027-03-02"},{is_active:false,start_date:"2027-04-01",end_date:"2027-04-02"}];
  const result=await f.run(),windows=result.units[0].windows;expect(windows.find((w:any)=>w.start===ms("2027-01-01T00:00"))?.qty).toBe(5);expect(windows.find((w:any)=>w.start===ms("2027-03-01T00:00"))?.qty).toBe(5);expect(windows.some((w:any)=>w.start===ms("2027-02-01T00:00")||w.start===ms("2027-04-01T00:00"))).toBe(false);expect(JSON.stringify(result)).not.toContain("PRIVATE");
 });
 it("preserves the manager booking/pickup start and a return buffer crossing midnight",async()=>{
  const f=fixture();f.tables.reservations=[f.rental({pickup_date:"2027-01-02",pickup_time:"10:00",return_date:"2027-01-04",return_time:"23:30"})];const result=await f.run();expect(result.units[0].windows).toEqual([{start:ms("2027-01-01T10:00"),end:ms("2027-01-05T00:30"),qty:1}]);
 });
 it("rejects malformed occupied quantities instead of dropping their constraints",async()=>{
  const f=fixture();f.tables.reservations=[f.rental({resolved_items:[{item_id:"body",qty:1.5}]})];await expect(f.run()).rejects.toThrow("Invalid shared occupancy");
 });
 it("dispatches the real internal snapshot behind the registered fixed read-only route",async()=>{
  vi.stubEnv("DBCINEMA_WEBHOOK_SECRET","shared-fixture-service");const f=fixture();const ctx={runQuery:async(ref:any,args:any)=>{expect(getFunctionName(ref)).toBe("items:__service_sharedStockForStorefront");expect(args).toEqual({});return (snapshot as any)._handler({db:f.db},args)}};const req=(args:any)=>new Request("https://fixture.convex.site/dbcinema/storefront-read",{method:"POST",headers:{"x-dbcinema-sync-token":"shared-fixture-service"},body:JSON.stringify({path:"items:sharedStockForStorefront",args})});const response=await (storefrontRead as any)._handler(ctx,req({}));expect(response.status).toBe(200);expect((await response.json()).value[0]).toMatchObject({version:1,units:[{masterItemId:"body",quantityOwned:3}]});expect((await (storefrontRead as any)._handler(ctx,req({account_slug:"other"}))).status).toBe(400);
 });
});
