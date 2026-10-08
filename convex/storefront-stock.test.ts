import {afterEach,describe,expect,it,vi} from "vitest";
vi.mock("./auth",()=>({authComponent:{registerRoutes:vi.fn(),safeGetAuthUser:vi.fn()},createAuth:vi.fn()}));
import {__service_sharedStockForStorefront as snapshot} from "./items";
import {storefrontRead} from "./http";
import {getCustodyReconciliationIds} from "./hygglo";
import {update as updateClaim, list as listClaims, advanceStage as advanceClaim} from "./insurance_claims";
import {repairHeldUnits} from "./lib/availability";
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
  const f=fixture();f.tables.reservations=[f.rental({renter_name:"PRIVATE CUSTOMER",notes:"PRIVATE NOTE"}),f.rental({_id:"web",hygglo_order_id:"web",account_slug:"dbcinema_web"}),f.rental({_id:"returned",hygglo_order_id:"returned",order_step:"REVIEWED"}),f.rental({_id:"cancelled",hygglo_order_id:"cancelled",status:"cancelled"}),f.rental({_id:"obsolete",hygglo_order_id:"obsolete",is_obsolete:true})];
  const result=await f.run();expect(f.reads).toEqual(["items","reservations","reservations","hygglo_product_index","listing_resolution_override","insurance_claims","owner_unavailability","vacation_periods"]);expect(result.units[0].windows).toEqual([{start:ms("2027-01-01T00:00"),end:ms("2027-01-03T00:00"),qty:1}]);expect(JSON.stringify(result)).not.toMatch(/PRIVATE|other-owned-account|booking|web|returned/);
 });
 it("matches real quoting for kit extensions and independently booked shared equipment",async()=>{
  const f=fixture();f.tables.reservations=[f.rental({hygglo_order_id:"first",renter_id:"renter"}),f.rental({_id:"extension",hygglo_order_id:"second",renter_id:"renter",start_date:"2027-01-02",end_date:"2027-01-03"}),f.rental({_id:"independent",hygglo_order_id:"third",renter_id:"different",start_date:"2027-01-02",end_date:"2027-01-02"})];
  const result=await f.run();expect(result.units[0].windows.map((w:any)=>w.qty)).toEqual([1,2,1]);const sources=await loadStockSources({db:f.db} as any),quote=stockForItem(sources,sources.items[0],{item_name:"Sony FX3",start_date:"2027-01-02",end_date:"2027-01-02"});expect(quote.free_units).toBe(1);expect(result.units[0].quantityOwned-Math.max(...result.units[0].windows.map((w:any)=>w.qty))).toBe(quote.free_units);
 });
 it("ends forecast occupancy at the booked return without clearing custody",async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-08"));const f=fixture();f.tables.reservations=[f.rental({status:"ongoing",order_step:"DELIVERED",start_date:"2026-08-01",end_date:"2026-08-02"})];let result=await f.run();expect(result.units[0].windows[0].end).toBe(ms("2026-08-03T00:00"));expect(f.tables.reservations[0].status).toBe("ongoing");f.tables.reservations[0].order_step="REVIEWED";result=await f.run();expect(result.units[0].windows).toEqual([]);
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
 it("counts partial audited kit quantities consistently in the real source snapshot and quote",async()=>{
  const f=fixture();f.tables.items[0].qty=12;f.tables.items.push({_id:"lens",name_canonical:"Lens",kind:"lens",status:"active",is_marketing_only:false,qty:5});const slug="other-owned-account";
  f.tables.listing_resolution_override=[{account_slug:slug,product_id:10,components:[{item_id:"body",qty:2}]},{account_slug:slug,product_id:11,components:[{item_id:"body",qty:1}]}];f.tables.hygglo_product_index=[{account_slug:slug,product_id:12,item_id:"lens"},{account_slug:slug,product_id:13,item_id:"body"}];
  f.tables.reservations=[f.rental({expanded_items:[{item_id:"body",qty:99},{item_id:"lens",qty:3}],resolved_items:[],hygglo_items:[{product_id:10,qty:2},{product_id:11,qty:2},{product_id:12,name:"Lens",qty:3},{product_id:13,name:"2x camera bodies",qty:2}]})];
  const result=await f.run();expect(result.units.find((u:any)=>u.masterItemId==="body").windows).toEqual([{start:ms("2027-01-01T00:00"),end:ms("2027-01-03T00:00"),qty:10}]);const sources=await loadStockSources({db:f.db} as any);expect(stockForItem(sources,sources.items[0],{item_name:"Sony FX3",start_date:"2027-01-01",end_date:"2027-01-01"}).free_units).toBe(2);
  f.tables.reservations[0].hygglo_items.reverse();expect((await f.run()).units).toEqual(result.units);
 });
 it("dispatches the real internal snapshot behind the registered fixed read-only route",async()=>{
  vi.stubEnv("DBCINEMA_WEBHOOK_SECRET","shared-fixture-service");const f=fixture();const ctx={runQuery:async(ref:any,args:any)=>{expect(getFunctionName(ref)).toBe("items:__service_sharedStockForStorefront");expect(args).toEqual({});return (snapshot as any)._handler({db:f.db},args)}};const req=(args:any)=>new Request("https://fixture.convex.site/dbcinema/storefront-read",{method:"POST",headers:{"x-dbcinema-sync-token":"shared-fixture-service"},body:JSON.stringify({path:"items:sharedStockForStorefront",args})});const response=await (storefrontRead as any)._handler(ctx,req({}));expect(response.status).toBe(200);expect((await response.json()).value[0]).toMatchObject({version:1,units:[{masterItemId:"body",quantityOwned:3}]});expect((await (storefrontRead as any)._handler(ctx,req({account_slug:"other"}))).status).toBe(400);
 });
});

function custodyFixture(rows:any[]){
 const reads:any[]=[];
 const db:any={query:(table:string)=>{let matching=rows;const query:any={withIndex:(name:string,fn:any)=>{reads.push({table,index:name});const q:any={eq:(key:string,value:any)=>{matching=matching.filter(r=>r[key]===value);return q}};fn(q);return query},order:()=>query,take:async(limit:number)=>{reads.at(-1).limit=limit;return matching.slice(0,limit)}};return query}};
 return {run:()=> (getCustodyReconciliationIds as any)._handler({db}, {account_slug:"dbcinema"}),reads};
}
describe("bounded source custody recovery",()=>{
 it("reads only protected indexed account/step windows, excluding returned, obsolete and future records",async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-08T00:00:00Z"));
  const row=(id:string,extra={})=>({account_slug:"dbcinema",hygglo_order_id:id,status:"confirmed",order_step:"DELIVERED",end_date:"2026-07-01",...extra});
  const f=custodyFixture([row("101"),row("102",{order_step:"RETURNED"}),row("103",{status:"completed"}),row("104",{is_obsolete:true}),row("105",{end_date:"2026-11-01"}),row("106",{account_slug:"leo"}),row("__probe__107")]);
  expect(await f.run()).toEqual(["101","102"]);
  expect(f.reads).toEqual([{table:"reservations",index:"by_account_order_step",limit:64},{table:"reservations",index:"by_account_order_step",limit:64}]);
 });
 it("rotates its provider-read cap across consecutive full/hourly polls",async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-08T00:00:00Z"));
  const f=custodyFixture(Array.from({length:24},(_,i)=>({account_slug:"dbcinema",hygglo_order_id:String(100+i),status:"confirmed",order_step:"DELIVERED",end_date:"2026-07-01"})));
  const first=await f.run();expect(first).toHaveLength(8);
  vi.advanceTimersByTime(3600000);const second=await f.run();expect(second).toHaveLength(8);expect(second.every((id:string)=>!first.includes(id))).toBe(true);
 });
});

describe("neutral claim closure",()=>{
 it("retains claim estimate and evidence, releases repair stock and audits without recording money",async()=>{
  const row:any={_id:"claim",stage:"in_for_repair",status:"open",amount_gbp:2500,description:"Original evidence",repair_item_ids:["body"]},audits:any[]=[];
  const ctx:any={db:{get:async()=>row,patch:async(_id:string,fields:any)=>Object.assign(row,fields),insert:async(table:string,record:any)=>{expect(table).toBe("audit_log");audits.push(record)},query:()=>{const q:any={withIndex:()=>q,order:()=>q,take:async()=>[row]};return q}}};
  expect(repairHeldUnits([row],"body" as any)).toBe(1);
  await (updateClaim as any)._handler(ctx,{id:"claim",status:"closed"});
  expect(row).toMatchObject({status:"closed",stage:"closed",amount_gbp:2500,description:"Original evidence",repair_item_ids:[]});
  expect(row.payout_amount_gbp).toBeUndefined();expect(row.credited_at).toBeUndefined();expect(row.credited_to_month).toBeUndefined();
  expect(repairHeldUnits([row],"body" as any)).toBe(0);expect(audits).toHaveLength(1);
  expect((await (listClaims as any)._handler(ctx,{}))[0].stage).toBe("closed");
  await (advanceClaim as any)._handler(ctx,{id:"claim"});expect(row.stage).toBe("closed");
  await (updateClaim as any)._handler(ctx,{id:"claim",status:"closed"});expect(audits).toHaveLength(1);
 });
 it("requires source settlement for website cases and preserves already credited financial history",async()=>{
  for(const row of [{site_case_id:"source-case"},{stage:"added_to_revenue",credited_at:123}]){
    const patch=vi.fn(),ctx:any={db:{get:async()=>row,patch}};
    await expect((updateClaim as any)._handler(ctx,{id:"claim",status:"closed"})).rejects.toThrow();expect(patch).not.toHaveBeenCalled();
  }
 });
});
