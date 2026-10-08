import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("./auth",()=>({authComponent:{safeGetAuthUser:vi.fn(async()=>({_id:'owner'}))}}));
import { getFunctionName } from "convex/server";
import { binding, context, refresh } from "./websiteVerification";
import { adminPatchRichFieldsByHyggloId, adminSetStatus, adminMarkUnreturned } from "./reservations";
const invoke=(f:any,ctx:any,args:any)=>f._handler(ctx,args);
const args={reservationId:'reservation-1'};
function fixture(){
 const row:any={_id:'reservation-1',account_slug:'dbcinema_web',hygglo_order_id:'website-booking',booking_status:'confirmed',site_revision:2};
 const q:any={withIndex:()=>q,collect:async()=>[row],first:async()=>({auth_user_id:'owner'})};
 const ctx:any={db:{get:vi.fn(async()=>row),query:()=>q,patch:vi.fn()},auth:{getUserIdentity:vi.fn(async()=>({subject:'owner',issuer:'https://owner.convex.site'}))},runMutation:vi.fn(async()=>({receipts:[{outcome:'applied'}]}))};
 ctx.runQuery=vi.fn(async(ref:any,params:any)=>getFunctionName(ref)==='owner_access:get'?{auth_user_id:'owner'}:invoke(binding,ctx,params));return {ctx,row};
}
beforeEach(()=>{vi.stubEnv('CONVEX_SITE_URL','https://owner.convex.site');vi.stubEnv('OWNER_AUTH_REQUIRED','false');vi.stubEnv('DBCINEMA_CONVEX_URL','https://website.example.invalid');vi.stubEnv('DBCINEMA_ADMIN_TOKEN','private-server-token')});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.clearAllMocks()});
it('keeps legacy paid bookings unapproved and permits only linked website rentals',async()=>{
 const {ctx,row}=fixture();expect(await invoke(context,ctx,args)).toMatchObject({bookingId:'website-booking',verification:null,sourceRevision:2});
 row.account_slug='leo';await expect(invoke(context,ctx,args)).rejects.toThrow('Select a DB Cinema');
});
it('rejects unauthenticated reads and refresh before contacting website',async()=>{
 const {ctx}=fixture();ctx.auth.getUserIdentity=vi.fn(async()=>null);const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 await expect(invoke(context,ctx,args)).rejects.toThrow();await expect(invoke(refresh,ctx,args)).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();
});
it('refreshes exactly one bound booking through authenticated source, never a financial endpoint',async()=>{
 const {ctx}=fixture();vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{const request=JSON.parse(options.body);expect(request).toMatchObject({path:'rmv2_sync:forRmv2SyncBooking',args:{token:'private-server-token',bookingId:'website-booking'}});return {ok:true,json:async()=>({status:'success',value:{id:'website-booking',revision:3}})}}));
 expect(await invoke(refresh,ctx,args)).toEqual({ok:true});expect(ctx.runMutation).toHaveBeenCalledTimes(1);expect(ctx.runMutation.mock.calls[0][1]).toEqual({bookings:[{id:'website-booking',revision:3}],reconcile:false});
});
it('rejects cross-booking source data and sanitizes provider errors',async()=>{
 const {ctx}=fixture();vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({status:'success',value:{id:'other'}})})));
 await expect(invoke(refresh,ctx,args)).rejects.toThrow('could not be refreshed');expect(ctx.runMutation).not.toHaveBeenCalled();
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:false,json:async()=>({status:'error',errorMessage:'private-server-token'})})));await expect(invoke(refresh,ctx,args)).rejects.not.toThrow('private-server-token');
});
it('blocks website approval and handover overrides without writing any row',async()=>{
 const {ctx}=fixture();for(const fields of [{order_step:'DELIVERED'},{order_step:'VERIFIED'},{booking_status:'active'}])await expect(invoke(adminPatchRichFieldsByHyggloId,ctx,{hygglo_order_id:'website-booking',...fields})).rejects.toThrow('must be managed in DB Cinema');expect(ctx.db.patch).not.toHaveBeenCalled();
});

it('blocks manual website status and return restoration overrides',async()=>{
 const {ctx,row}=fixture();await expect(invoke(adminSetStatus,ctx,{reservation_id:row._id,new_status:'active',reason:'local override'})).rejects.toThrow('must be managed in DB Cinema');
 row.status='completed';await expect(invoke(adminMarkUnreturned,ctx,{reservationId:row._id})).rejects.toThrow('must be managed in DB Cinema');expect(ctx.db.patch).not.toHaveBeenCalled();
});
