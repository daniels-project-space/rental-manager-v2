import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryAdapter } from "better-auth/adapters/memory";
import { getFunctionName } from "convex/server";
const state=vi.hoisted(()=>({database:{} as Record<string,any[]>,owner:null as any,mails:[] as any[],failMail:false,failReserve:false}));
// Only Convex identity/database transport is replaced. Actual pinned Better Auth
// handlers, password hashing, reset token expiry/consumption and session deletion run.
vi.mock("@convex-dev/better-auth",()=>({createClient:()=>({adapter:()=>memoryAdapter(state.database),safeGetAuthUser:vi.fn()})}));
vi.mock("@convex-dev/better-auth/plugins",()=>({convex:()=>({id:"controlled-convex-token-transport"})}));
vi.mock("./auth.config",()=>({default:{providers:[]}}));
import { createAuth } from "./auth";
import { claimRecoveryToken, reserveRecoveryMail } from "./owner_access";
const origin="http://127.0.0.1:41950",email="owner@example.invalid",initial="Initial-owner-password-123!",updated="Updated-owner-password-456!";
let auth:ReturnType<typeof createAuth>;
beforeEach(async()=>{
 state.database={user:[],session:[],account:[],verification:[],rateLimit:[]};state.owner=null;state.mails=[];state.failMail=false;state.failReserve=false;
 vi.stubEnv("SITE_URL",origin);vi.stubEnv("BETTER_AUTH_SECRET","controlled-owner-recovery-test-secret-at-least-32-characters");vi.stubEnv("OWNER_RECOVERY_RESEND_API_KEY","re_controlled_test_key");vi.stubEnv("OWNER_RECOVERY_FROM","Rental Manager <access@dbcinemarentals.com>");
 const invite="controlled-private-owner-invite-token";const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(invite));vi.stubEnv("OWNER_SETUP_TOKEN_HASH",Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join(""));
 vi.stubGlobal("fetch",vi.fn(async(_url,init)=>{if(state.failMail)return new Response('{}',{status:503});state.mails.push(JSON.parse(String(init.body)));return new Response('{"id":"controlled-provider-receipt"}',{status:200});}));
 const db={query:()=>({first:async()=>state.owner}),patch:async(_id:string,values:any)=>Object.assign(state.owner,values)};
 const ctx={runQuery:async()=>state.owner,runMutation:async(ref:any,args:any)=>{
  const name=getFunctionName(ref);if(name==="owner_access:register"){state.owner={_id:"singleton",...args,email:args.email.toLowerCase()};return "singleton";}
  if(name==="owner_access:reserveRecoveryMail"){if(state.failReserve)throw Error("Controlled database failure");return (reserveRecoveryMail as any)._handler({db},args);}
  if(name==="owner_access:claimRecoveryToken")return (claimRecoveryToken as any)._handler({db},args);
  throw Error("Unexpected auth transport mutation "+name);
 }};
 auth=createAuth(ctx as any);
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.useRealTimers();});
async function request(path:string,body?:any,extra:Record<string,string>={}){return auth.handler(new Request(origin+"/api/auth"+path,{method:body?"POST":"GET",headers:{Origin:origin,"Content-Type":"application/json","x-forwarded-for":"192.0.2.2",...extra},body:body?JSON.stringify(body):undefined}));}
async function signup(){const r=await request("/sign-up/email",{email,password:initial,name:"Controlled owner"},{"x-owner-setup-invite":"controlled-private-owner-invite-token"});expect(r.status).toBe(200);return (await r.json()).token as string;}
async function resetRequest(address=email){return request("/request-password-reset",{email:address,redirectTo:origin+"/login?returnTo="+encodeURIComponent("/renter-bot-lab?chat=42#messages")});}
function latestToken(){return new URLSearchParams(new URL(state.mails.at(-1).text.match(/http[^\s]+/)[0]).hash.slice(1)).get("reset")!;}
describe("actual owner password recovery API",()=>{
 it("resets the registered owner once, changes password and revokes all existing sessions",async()=>{
  const session=await signup();expect(state.database.session.length).toBe(1);
  const r=await resetRequest();expect(r.status).toBe(200);expect(state.mails).toHaveLength(1);expect(state.mails[0].to).toEqual([email]);
  const token=latestToken(),link=state.mails[0].text.match(/http[^\s]+/)[0];expect(new URL(link).searchParams.get("returnTo")).toBe("/renter-bot-lab?chat=42#messages");
  expect((await request("/reset-password",{newPassword:updated,token})).status).toBe(200);expect(state.database.session).toHaveLength(0);
  expect((await request("/reset-password",{newPassword:initial,token})).status).toBe(400);
  expect((await request("/sign-in/email",{email,password:initial})).status).toBe(401);
  expect((await request("/sign-in/email",{email,password:updated})).status).toBe(200);expect(state.owner.auth_user_id).toBe(state.database.user[0].id);
  expect(session).toBeTruthy();
 });
 it("does not email or create a user for unknown or unbound identities, and rejects external redirects",async()=>{
  await signup();expect((await resetRequest("unknown@example.invalid")).status).toBe(200);expect(state.mails).toHaveLength(0);expect(state.database.user).toHaveLength(1);
  state.owner={...state.owner,auth_user_id:"different-owner"};expect((await resetRequest()).status).toBe(200);expect(state.mails).toHaveLength(0);
  expect((await request("/request-password-reset",{email,redirectTo:"https://evil.example/login"})).status).toBe(403);expect(state.mails).toHaveLength(0);
 });
 it("requires delivery configuration and acknowledgement, and rejects expired/short password tokens",async()=>{
  await signup();vi.stubEnv("OWNER_RECOVERY_RESEND_API_KEY","");expect((await resetRequest()).status).toBe(503);expect(state.mails).toHaveLength(0);
  vi.stubEnv("OWNER_RECOVERY_RESEND_API_KEY","re_controlled_test_key");state.failMail=true;expect((await resetRequest()).status).toBe(503);expect(state.mails).toHaveLength(0);
  state.failMail=false;state.owner.recovery_mail_requested_at=Date.now()-60_001;expect((await resetRequest()).status).toBe(200);const token=latestToken();
  expect((await request("/reset-password",{newPassword:"short",token})).status).toBe(400);
  state.database.verification.find(x=>x.identifier===`reset-password:${token}`).expiresAt=new Date(Date.now()-1);
  expect((await request("/reset-password",{newPassword:updated,token})).status).toBe(400);expect(state.database.session).toHaveLength(1);
 });
 it("uses persistent API rate limits and the owner cooldown without relying on client buttons",async()=>{
  await signup();for(let i=0;i<3;i++)expect((await resetRequest()).status).toBe(200);
  expect(state.mails).toHaveLength(1);expect((await resetRequest()).status).toBe(429);expect(state.database.rateLimit.length).toBeGreaterThan(0);
 });
 it("reports an unconfirmed database reservation as failure rather than false email success",async()=>{
  await signup();state.failReserve=true;expect((await resetRequest()).status).toBe(503);expect(state.mails).toHaveLength(0);
 });
 it("allows only one of two simultaneous requests to consume the same reset link",async()=>{
  await signup();expect((await resetRequest()).status).toBe(200);const token=latestToken();
  const attempts=await Promise.all([request("/reset-password",{newPassword:updated,token}),request("/reset-password",{newPassword:"Other-concurrent-password-789!",token})]);
  expect(attempts.map(r=>r.status).sort()).toEqual([200,400]);
 });
 it("a fresh request preserves an earlier email until one link consumes all pending owner tokens",async()=>{
  await signup();expect((await resetRequest()).status).toBe(200);const earlier=latestToken();
  state.owner.recovery_mail_requested_at=Date.now()-60_001;expect((await resetRequest()).status).toBe(200);const current=latestToken();
  expect((await request("/reset-password",{newPassword:updated,token:earlier})).status).toBe(200);
  expect((await request("/reset-password",{newPassword:updated,token:current})).status).toBe(400);
  expect(state.owner.auth_user_id).toBe(state.database.user[0].id);
 });
});
