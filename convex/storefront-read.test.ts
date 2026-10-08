import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./auth", () => ({authComponent:{registerRoutes:vi.fn(),safeGetAuthUser:vi.fn()},createAuth:vi.fn()}));
import http, { storefrontRead } from "./http";
import { __service_listForStorefront as itemsService, listForReconcile as itemsPublic } from "./items";
import { __service_listForStorefront as productsService } from "./hygglo_products";
import { __service_listActiveForStorefront as activeService, __service_listDemandForStorefront as demandService } from "./reservations";
import { getFunctionName } from "convex/server";
const secret="fixture-read-service";
const request=(body:unknown={path:"items:listForReconcile",args:{}},token:string|null=secret)=>new Request("https://fixture-manager.convex.site/dbcinema/storefront-read",{method:"POST",headers:token?{"x-dbcinema-sync-token":token}:{},body:typeof body==="string"?body:JSON.stringify(body)});
const invoke=(ctx:any,req:Request)=>(storefrontRead as any)._handler(ctx,req);
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks()});
describe("registered private storefront read transport",()=>{
 it("is routed as POST and rejects missing service setup or wrong credentials before reads",async()=>{
  expect(http.lookup("/dbcinema/storefront-read","POST")?.[0]).toBe(storefrontRead);
  expect(http.lookup("/dbcinema/storefront-read","GET")).toBeNull();
  const runQuery=vi.fn();vi.stubEnv("DBCINEMA_WEBHOOK_SECRET","");expect((await invoke({runQuery},request())).status).toBe(503);
  vi.stubEnv("DBCINEMA_WEBHOOK_SECRET",secret);for(const token of [null,"bad"]){expect((await invoke({runQuery},request(undefined,token))).status).toBe(401)}expect(runQuery).not.toHaveBeenCalled();
 });
 it.each([
  "not json",{path:"items:listForReconcile",args:[]},{path:"items:listForReconcile",args:{token:"injected"}},
  {path:"items:listForReconcile",args:{},write:true},{path:"bookings:delete",args:{}},{path:"constructor",args:{}},
  {path:"hygglo_products:list",args:{}},{path:"hygglo_products:list",args:{accountSlug:"other"}},
  {path:"reservations:listForReconcile",args:{account_slug:"all"}},{path:"reservations:listActiveForStorefront",args:{account_slug:"dbcinema",limit:100}},
 ])("rejects unsupported account/functions/arguments without dispatch: %j",async body=>{
  vi.stubEnv("DBCINEMA_WEBHOOK_SECRET",secret);const runQuery=vi.fn();const response=await invoke({runQuery},request(body));expect(response.status).toBe(400);expect(runQuery).not.toHaveBeenCalled();
 });
 it("bounds the authenticated request and hides source exceptions",async()=>{
  vi.stubEnv("DBCINEMA_WEBHOOK_SECRET",secret);const runQuery=vi.fn();expect((await invoke({runQuery},request("x".repeat(4097)))).status).toBe(413);expect(runQuery).not.toHaveBeenCalled();
  const response=await invoke({runQuery:async()=>{throw Error("PRIVATE SOURCE DETAIL")}},request());expect(response.status).toBe(503);expect(await response.text()).not.toContain("PRIVATE");
 });
 it("uses actual internal counterparts while public inventory remains owner-protected",async()=>{
  vi.stubEnv("OWNER_AUTH_REQUIRED","true");vi.stubEnv("DBCINEMA_WEBHOOK_SECRET",secret);
  const rows:any={items:[{_id:"body",name_canonical:"Fixture camera",qty:2,status:"active",is_marketing_only:false}],hygglo_products:[{accountSlug:"dbcinema",productId:10,name:"Fixture kit",masterItemId:"body",private_note:"SECRET"},{accountSlug:"other",productId:11,name:"Other account"}],reservations:[{_id:"r1",account_slug:"dbcinema",start_date:"2090-01-01",end_date:"2090-01-02",status:"confirmed",order_step:"DELIVERED",renter_name:"PRIVATE",items:[{product_id:10,qty:1,item_name:"Fixture camera",private_note:"SECRET"}],resolved_items:[{item_id:"body",qty:1,item_name_canonical:"Fixture camera",private_note:"SECRET"}]}]};
  const db={query:(table:string)=>{let values=rows[table]??[];const q:any={withIndex:(_:string,fn:any)=>{const selector:any={eq:(k:string,v:any)=>{values=values.filter((r:any)=>r[k]===v);return selector},gte:(k:string,v:any)=>{values=values.filter((r:any)=>r[k]>=v);return selector}};fn(selector);return q},collect:async()=>values};return q}};
  await expect((itemsPublic as any)._handler({db,auth:{getUserIdentity:async()=>null}},{})).rejects.toThrow("OWNER_AUTH_REQUIRED");
  const counterparts:any={"items:__service_listForStorefront":itemsService,"hygglo_products:__service_listForStorefront":productsService,"reservations:__service_listActiveForStorefront":activeService,"reservations:__service_listDemandForStorefront":demandService};
  const reads:string[]=[];const ctx={runQuery:async(ref:any,args:any)=>{const name=getFunctionName(ref);reads.push(name);return counterparts[name]._handler({db},args)}};
  for(const [path,args] of [["items:listForReconcile",{}],["hygglo_products:list",{accountSlug:"dbcinema"}],["reservations:listActiveForStorefront",{account_slug:"dbcinema"}],["reservations:listForReconcile",{account_slug:"dbcinema"}]] as const){
   const response=await invoke(ctx,request({path,args}));expect(response.status).toBe(200);expect(response.headers.get("Cache-Control")).toBe("no-store");const receipt=await response.json();expect(receipt).toMatchObject({protocolVersion:1,status:"success",path});expect(receipt.value).toHaveLength(1);expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE|SECRET|Other account/);
  }
  expect(reads).toHaveLength(4);
 });
});
