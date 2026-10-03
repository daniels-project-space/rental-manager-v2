import { NextResponse } from "next/server";
import { withServiceRoute } from "@/lib/owner-http-route";
import { api } from "../../../../../convex/_generated/api";
export const runtime="nodejs";
/** Device capability only: no cookie, activation or preference changes. */
export const POST=withServiceRoute(async(req,convex)=>{
 let body:Record<string,unknown>;
 try{body=await req.json();}catch{return NextResponse.json({ok:false,error:"bad_request"},{status:400});}
 const fields=["endpoint","previous_endpoint","p256dh","auth","renewal_credential"] as const;
 if(!body || fields.some(k=>typeof body[k]!=="string"||!body[k]||String(body[k]).length>4096))return NextResponse.json({ok:false,error:"bad_request"},{status:400});
 if(!/^[a-f0-9]{64}$/.test(body.renewal_credential as string))return NextResponse.json({ok:false,error:"registration_unavailable"},{status:403});
 try{
  const result=await convex.mutation(api.notifications.renewPushSubscription,{endpoint:body.endpoint as string,previous_endpoint:body.previous_endpoint as string,p256dh:body.p256dh as string,auth:body.auth as string,renewal_credential:body.renewal_credential as string});
  return NextResponse.json({ok:result.active,...result},{status:result.active?200:result.status==="renewal_required"?409:403});
 }catch{return NextResponse.json({ok:false,error:"renewal_failed"},{status:503});}
});
