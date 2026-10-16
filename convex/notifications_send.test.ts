import { afterEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
vi.mock("web-push",()=>({default:{setVapidDetails:vi.fn(),sendNotification:vi.fn(async()=>({statusCode:201}))}}));
vi.mock("./lib/telegram_convex",()=>({automatedTelegramAlertsEnabled:()=>false}));
import webpush from "web-push";
import { dispatchPending } from "./notifications_send";
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks()});
async function dispatch(type:string,extra:any={}){
 vi.stubEnv("VAPID_PUBLIC_KEY","fixture-public");vi.stubEnv("VAPID_PRIVATE_KEY","fixture-private");
 const row={_id:"fixture-notice",type,thread_id:"fixture-thread",account_slug:"diogo",title:"Fixture alert",body:"Sony FX3",url:"/?thread=fixture-thread",created_at:Date.now(),...extra};
 const runMutation=vi.fn(async(ref:any,args:any)=>getFunctionName(ref)==="notifications:claimPending"?[row]:{delivered:1,retryable:0});
 const modes=["all","my_share","money_only"];
 const ctx={runMutation,runQuery:async()=>modes.map(mode=>({mode,endpoint:`https://${mode}.example.invalid`,p256dh:"fixture",auth:"fixture"})),scheduler:{runAfter:vi.fn()}};
 await(dispatchPending as any)._handler(ctx,{});
 return {calls:vi.mocked(webpush.sendNotification).mock.calls,runMutation};
}
describe("actual notification dispatcher with isolated transports",()=>{
 it.each(["pickup_reminder","rental_time_changed"])("delivers %s only to All notifications",async type=>{
  const {calls}=await dispatch(type);expect(calls).toHaveLength(1);expect(calls[0][0].endpoint).toBe("https://all.example.invalid");
  if(type==="pickup_reminder")expect(calls[0][2]).toEqual({TTL:60,urgency:"high"});
 });
 it("keeps the item and exact half income in the actual 50% phone payload",async()=>{
  const {calls}=await dispatch("booking_confirmed",{copy_data:{item_name:"Sony FX3",renter_name:"Fixture",net:81,gross:100,currency:"GBP"}});
  expect(calls).toHaveLength(3);
  const share=JSON.parse(String(calls.find(c=>c[0].endpoint==="https://my_share.example.invalid")![1]!));
  expect(share).toMatchObject({title:"🎉 Wohoo, you made £40.50!",body:"Sony FX3 on Diogo · Your 50% share"});
 });
});
