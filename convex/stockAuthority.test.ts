import {afterEach,describe,expect,it,vi} from "vitest";
vi.mock("../src/lib/hygglo-auth",()=>({HYGGLO_API_BASE:"https://provider.invalid",getAccountCredentials:vi.fn(async()=>({})),getHyggloAccessToken:vi.fn(async()=>"fixture"),hyggloAuthHeaders:()=>({})}));
import {backfillLegacyApprovalClaims,prepareHyggloApproval} from "./stockAuthority";
import {loadStockSources,stockForItem} from "./lib/renter_stock";
import {sharedStockSnapshot} from "./lib/storefront_stock";
import {acceptOrder,manualApproveOrder} from "../src/lib/hygglo-write";
function fixture(){
 const tables:any={items:[{_id:"body",name_canonical:"Sony FX3",kind:"camera_body",status:"active",is_marketing_only:false,qty:2},{_id:"lens",name_canonical:"Lens",kind:"lens",status:"active",is_marketing_only:false,qty:1}],reservations:[],stock_approval_claims:[],listing_resolution_override:[{account_slug:"leo",product_id:10,components:[{item_id:"body",qty:1},{item_id:"lens",qty:1}]}],hygglo_products:[],online_listings:[],hygglo_product_index:[],insurance_claims:[],owner_unavailability:[],vacation_periods:[]};
 let id=0;const db:any={query:(table:string)=>{let rows=tables[table]??[];const q:any={withIndex:(_:string,fn:any)=>{const filter:any={eq:(key:string,value:any)=>{rows=rows.filter((r:any)=>r[key]===value);return filter}};fn(filter);return q},collect:async()=>rows,take:async(count:number)=>rows.slice(0,count),first:async()=>rows[0]??null};return q},insert:async(table:string,row:any)=>{const key="claim-"+(++id);tables[table].push({...row,_id:key});return key}};
 const rental=(order:string,extra:any={})=>{const row={_id:"r-"+order,account_slug:"leo",hygglo_order_id:order,status:"pending_review",order_step:"REQUEST",start_date:"2027-01-01",end_date:"2027-01-02",hygglo_items:[{name:"FX3 and lens",product_id:10,qty:1}],...extra};tables.reservations.push(row);return row};
 db.patch=async(id:string,patch:any)=>{for(const rows of Object.values(tables) as any[][]){const row=rows.find(r=>r._id===id);if(row){Object.assign(row,patch);return}}throw Error("missing fixture row")};
 const ctx:any={db,scheduler:{runAfter:vi.fn(async()=>{})}};const prepare=(order:string,accountSlug="leo")=>(prepareHyggloApproval as any)._handler(ctx,{accountSlug,hyggloOrderId:order});
 const authority=(args:any)=>(prepareHyggloApproval as any)._handler(ctx,args);
 return{tables,ctx,rental,prepare,authority};
}
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals()});
describe("provider approval physical stock claim",()=>{
 it("backfills legacy claims in bounded replay-safe batches without releasing stock",async()=>{
  const f=fixture();for(let index=0;index<51;index++)f.tables.stock_approval_claims.push({_id:`legacy-${index}`,account_slug:"leo",order_id:`order-${index}`});
  expect(await(backfillLegacyApprovalClaims as any)._handler(f.ctx,{})).toEqual({updated:50,continued:true});
  expect(f.tables.stock_approval_claims.filter((claim:any)=>claim.holds_stock===true)).toHaveLength(50);
  expect(f.tables.stock_approval_claims.filter((claim:any)=>claim.holds_stock===false)).toHaveLength(0);
  expect(await(backfillLegacyApprovalClaims as any)._handler(f.ctx,{})).toEqual({updated:1,continued:false});
  expect(await(backfillLegacyApprovalClaims as any)._handler(f.ctx,{})).toEqual({updated:0,continued:false});
  expect(f.ctx.scheduler.runAfter).toHaveBeenCalledTimes(1);
 });
 it("keeps legacy, active and unproven inactive claims fail-closed",async()=>{
  const f=fixture();const row=f.rental("first");await f.prepare("first");
  const claim=f.tables.stock_approval_claims[0];expect(claim.holds_stock).toBe(true);
  f.tables.stock_approval_claims.push({...claim,_id:"legacy",order_id:"legacy",reservation_id:"other",holds_stock:undefined});
  f.tables.stock_approval_claims.push({...claim,_id:"unproven",order_id:"unproven",reservation_id:"other",holds_stock:false});
  const sources=await loadStockSources(f.ctx);expect(sources.approvalClaims).toHaveLength(3);
  expect(stockForItem(sources,sources.items[1],{item_name:"Lens",start_date:row.start_date,end_date:row.start_date}).free_units).toBe(0);
  for(let index=0;index<499;index++)f.tables.stock_approval_claims.push({...claim,_id:`unproven-${index}`,order_id:`unproven-${index}`,holds_stock:false});
  await expect(loadStockSources(f.ctx)).rejects.toThrow(/reconciliation/);
 });
 it("claims the whole kit before the actual provider PATCH and excludes a second lens request",async()=>{
  const f=fixture();f.rental("first");f.rental("second");vi.stubEnv("ALLOW_MANUAL_ORDER_ACTIONS","true");
  const patch=vi.fn(async()=>{expect(f.tables.stock_approval_claims).toHaveLength(1);expect(f.tables.stock_approval_claims[0].components).toEqual([{item_id:"body",qty:1},{item_id:"lens",qty:1}]);return new Response("{}",{status:200})});vi.stubGlobal("fetch",patch);
  expect((await manualApproveOrder({accountSlug:"leo",hyggloOrderId:"first"},f.authority)).status).toBe("sent");
  expect((await manualApproveOrder({accountSlug:"leo",hyggloOrderId:"second"},f.authority)).status).toBe("failed");expect(patch).toHaveBeenCalledTimes(1);expect(f.tables.stock_approval_claims).toHaveLength(1);
  const sources=await loadStockSources(f.ctx);expect(stockForItem(sources,sources.items[1],{item_name:"Lens",start_date:"2027-01-01",end_date:"2027-01-01"}).free_units).toBe(0);
  const snapshot=sharedStockSnapshot(sources,Date.now());expect(snapshot.units.find(u=>u.masterItemId==="lens")?.windows[0].qty).toBe(1);expect(JSON.stringify(snapshot)).not.toMatch(/claim-|r-first|leo/);
 });
 it("serializes competing provider entry paths at the authority boundary",async()=>{
  const f=fixture();f.rental("first");f.rental("second");vi.stubEnv("ALLOW_MANUAL_ORDER_ACTIONS","true");vi.stubEnv("READ_ONLY_MODE","false");
  let queue=Promise.resolve();const authority=(args:any)=>{const result=queue.then(()=>f.authority(args));queue=result.then(()=>{},()=>{});return result};
  const patch=vi.fn(async()=>new Response("{}",{status:200}));vi.stubGlobal("fetch",patch);
  const results=await Promise.all([manualApproveOrder({accountSlug:"leo",hyggloOrderId:"first"},authority),acceptOrder({accountSlug:"leo",hyggloOrderId:"second"},authority)]);
  expect(results.map(result=>result.status).sort()).toEqual(["failed","sent"]);expect(patch).toHaveBeenCalledTimes(1);expect(f.tables.stock_approval_claims).toHaveLength(1);
 });
 it("retains the claim after a lost provider response and prevents another PATCH",async()=>{
  const f=fixture();f.rental("first");vi.stubEnv("READ_ONLY_MODE","false");const patch=vi.fn(async()=>{throw Error("response lost")});vi.stubGlobal("fetch",patch);
  expect((await acceptOrder({accountSlug:"leo",hyggloOrderId:"first"},f.authority)).status).toBe("failed");f.tables.stock_approval_claims[0].prepared_at=0;
  expect((await acceptOrder({accountSlug:"leo",hyggloOrderId:"first"},f.authority)).error).toMatch(/reconciliation/);expect(patch).toHaveBeenCalledTimes(1);expect(f.tables.stock_approval_claims).toHaveLength(1);
 });
 it("keeps an unmatched uncertain approval occupied after its original return",async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date("2027-01-04T12:00:00Z"));
  const f=fixture();f.rental("first");await f.prepare("first");
  const sources=await loadStockSources(f.ctx);
  expect(stockForItem(sources,sources.items[1],{item_name:"Lens",start_date:"2027-01-05",end_date:"2027-01-05"}).free_units).toBe(0);
  vi.useRealTimers();
 });
 it("does not double-count an exact confirmed mirror, but keeps a changed mirror conservative",async()=>{
  const f=fixture();const row=f.rental("first");await f.prepare("first");row.status="confirmed";row.order_step="APPROVED";
  let sources=await loadStockSources(f.ctx);expect(stockForItem(sources,sources.items[0],{item_name:"Sony FX3",start_date:"2027-01-01",end_date:"2027-01-01"}).free_units).toBe(1);
  row.end_date="2027-01-03";sources=await loadStockSources(f.ctx);expect(stockForItem(sources,sources.items[0],{item_name:"Sony FX3",start_date:"2027-01-01",end_date:"2027-01-01"}).free_units).toBe(0);
 });
 it("rejects a multi-component conflict before inserting any claim",async()=>{
  const f=fixture();f.rental("first");f.tables.reservations.push({_id:"occupied",status:"confirmed",start_date:"2027-01-01",end_date:"2027-01-02",expanded_items:[{item_id:"lens",qty:1}]});await expect(f.prepare("first")).rejects.toThrow(/Not enough/);expect(f.tables.stock_approval_claims).toEqual([]);
 });
 it("counts the return buffer crossing midnight and owner/repair constraints",async()=>{
  const f=fixture();f.rental("first",{start_date:"2027-01-02",end_date:"2027-01-02",pickup_time:"00:15"});f.tables.reservations.push({_id:"occupied",status:"confirmed",start_date:"2027-01-01",end_date:"2027-01-01",return_time:"23:30",expanded_items:[{item_id:"lens",qty:1}]});await expect(f.prepare("first")).rejects.toThrow(/Not enough/);
  f.tables.reservations.pop();f.tables.owner_unavailability.push({item_id:"lens",start_date:"2027-01-02",end_date:"2027-01-02"});await expect(f.prepare("first")).rejects.toThrow(/Not enough/);
  f.tables.owner_unavailability=[];f.tables.insurance_claims.push({stage:"in_for_repair",repair_item_ids:["lens"]});await expect(f.prepare("first")).rejects.toThrow(/Not enough/);expect(f.tables.stock_approval_claims).toEqual([]);
 });
 it("rejects missing, foreign, ambiguous, unowned and unmapped requests",async()=>{
  const f=fixture();await expect(f.prepare("missing")).rejects.toThrow(/missing or ambiguous/);f.rental("first");await expect(f.prepare("first","other")).rejects.toThrow(/missing or ambiguous/);
  f.rental("first");await expect(f.prepare("first")).rejects.toThrow(/ambiguous/);f.tables.reservations.pop();f.tables.items[1].is_marketing_only=true;await expect(f.prepare("first")).rejects.toThrow(/mapping/);f.tables.items[1].is_marketing_only=false;f.tables.listing_resolution_override=[];await expect(f.prepare("first")).rejects.toThrow(/mapping/);expect(f.tables.stock_approval_claims).toEqual([]);
 });
 it("checks existing gates before claiming stock and refuses an absent authority receipt",async()=>{
  const authority=vi.fn();const patch=vi.fn();vi.stubGlobal("fetch",patch);vi.stubEnv("ALLOW_MANUAL_ORDER_ACTIONS","false");expect((await manualApproveOrder({accountSlug:"leo",hyggloOrderId:"first"},authority)).status).toBe("skipped");expect(authority).not.toHaveBeenCalled();
  vi.stubEnv("ALLOW_MANUAL_ORDER_ACTIONS","true");expect((await manualApproveOrder({accountSlug:"leo",hyggloOrderId:"first"},authority)).status).toBe("failed");expect(patch).not.toHaveBeenCalled();
 });
});
