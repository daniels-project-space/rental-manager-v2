import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./auth",()=>({authComponent:{safeGetAuthUser:vi.fn(async()=>({_id:'owner'}))}}));
import { getFunctionName } from "convex/server";
import { preview,settle,link } from "./websiteReturns";
import { markReturned } from "./reservations";
const invoke=(f:any,ctx:any,args:any)=>f._handler(ctx,args);
const args={reservationId:'reservation-1',actualReturnedAt:Date.now(),damageKept:0,chargeLate:true,inspection:[{key:'camera:1',condition:'good',details:'',openCase:false}]};
function context(){
 const row={_id:'reservation-1',account_slug:'dbcinema_web',hygglo_order_id:'website-booking',status:'confirmed'};
 const queryCtx:any={db:{get:vi.fn(async()=>row)}};
 const ctx:any={auth:{getUserIdentity:vi.fn(async()=>({subject:'owner',issuer:'https://owner.convex.site'}))},runQuery:vi.fn(async(ref:any,params:any)=>getFunctionName(ref)==='owner_access:get'?{auth_user_id:'owner'}:invoke(link,queryCtx,params)),runMutation:vi.fn(async()=>({upserted:1}))};return {ctx,row,queryCtx};
}
function transport(failure?:string){return vi.fn(async(_url:any,options:any)=>{
 const request=JSON.parse(options.body);expect(request.args.token).toBe('private-server-token');
 if(request.path==='returnInspections:context')return {ok:true,json:async()=>({status:'success',value:{status:'active',returnDecision:null,items:[{key:'camera:1'}]}})};
 if(request.path==='checkout:markReturned'){
  if(failure==='settlement')return {ok:false,json:async()=>({status:'error',errorMessage:'Saved decision conflicts'})};
  expect(request.args.bookingId).toBe('website-booking');expect(request.args.inspection).toEqual(args.inspection);return {ok:true,json:async()=>({status:'success',value:{ok:true,released:40,kept:0,lateAmount:0}})};
 }
 if(failure==='sync')throw Error('connection interrupted');
 return {ok:true,json:async()=>({status:'success',value:{id:'website-booking',status:'returned',revision:2}})};
 })}
beforeEach(()=>{vi.stubEnv('CONVEX_SITE_URL','https://owner.convex.site');vi.stubEnv('OWNER_AUTH_REQUIRED','false');vi.stubEnv('DBCINEMA_CONVEX_URL','https://website.example.invalid');vi.stubEnv('DBCINEMA_ADMIN_TOKEN','private-server-token');vi.stubEnv('ALLOW_WEBSITE_RETURN_WRITES','true')});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.clearAllMocks()});
describe('real website return bridge actions',()=>{
 it('requires a live owner session even when the rollout-wide owner switch is off',async()=>{
  const {ctx}=context();ctx.auth.getUserIdentity.mockResolvedValue(null);const fetch=transport();vi.stubGlobal('fetch',fetch);
  await expect(invoke(preview,ctx,{reservationId:args.reservationId})).rejects.toThrow('OWNER_AUTH_REQUIRED');expect(fetch).not.toHaveBeenCalled();
 });
 it('keeps settlement gated while allowing authorised preview without exposing the connection token',async()=>{
  vi.stubEnv('ALLOW_WEBSITE_RETURN_WRITES','false');const {ctx}=context();const fetch=transport();vi.stubGlobal('fetch',fetch);
  const data=await invoke(preview,ctx,{reservationId:args.reservationId});expect(data.executionEnabled).toBe(false);expect(JSON.stringify(data)).not.toContain('private-server-token');
  await expect(invoke(settle,ctx,args)).rejects.toThrow('not enabled');expect(fetch).toHaveBeenCalledTimes(1);expect(ctx.runMutation).not.toHaveBeenCalled();
 });
 it('redacts the server connection secret from validation errors',async()=>{
  const {ctx}=context();vi.stubGlobal('fetch',vi.fn(async()=>({ok:false,json:async()=>({status:'error',errorMessage:'Invalid arguments token private-server-token'})})));
  await expect(invoke(preview,ctx,{reservationId:args.reservationId})).rejects.toThrow('Invalid arguments token [redacted]');
 });
 it('settles the linked website booking then reconciles its actual returned revision',async()=>{
  const {ctx}=context();vi.stubGlobal('fetch',transport());expect(await invoke(settle,ctx,args)).toMatchObject({ok:true,released:40,syncPending:false});
  expect(ctx.runMutation).toHaveBeenCalledWith(expect.anything(),{bookings:[{id:'website-booking',status:'returned',revision:2}],reconcile:false});
 });
 it('leaves Rental Manager open after a rejected settlement',async()=>{
  const {ctx}=context();vi.stubGlobal('fetch',transport('settlement'));await expect(invoke(settle,ctx,args)).rejects.toThrow('Saved decision conflicts');expect(ctx.runMutation).not.toHaveBeenCalled();
 });
 it('reports a completed settlement separately from a delayed manager update',async()=>{
  const {ctx}=context();vi.stubGlobal('fetch',transport('sync'));expect(await invoke(settle,ctx,args)).toMatchObject({ok:true,syncPending:true});expect(ctx.runMutation).not.toHaveBeenCalled();
 });
 it('rejects foreign or cancelled reservations and prevents the generic Hygglo mutation from marking website rentals complete',async()=>{
  const {ctx,row,queryCtx}=context();await expect(invoke(markReturned,{...ctx,...queryCtx},{reservationId:args.reservationId,condition:'good'})).rejects.toThrow('website item inspection');row.account_slug='leo';await expect(invoke(link,queryCtx,{reservationId:args.reservationId})).rejects.toThrow('Select a DB Cinema');row.account_slug='dbcinema_web';row.status='cancelled';await expect(invoke(link,queryCtx,{reservationId:args.reservationId})).rejects.toThrow('cancelled');
 });
});
