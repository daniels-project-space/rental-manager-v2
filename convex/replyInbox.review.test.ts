import { ownerChecksForBot } from "./renter_bot_owner_checks";
import schema from "./schema";
import { CONVERSATION_STAGES } from "./lib/renter_bot_intents";
import { validateRenterBotOutput } from "../src/lib/renter-bot-output";
import { describe, expect, it, vi } from "vitest";
import { setDraftReview, setDraft, threadsNeedingDraft, claimDraftGeneration, releaseDraftGeneration, getDraftApprovalContext, recheckCopiedDraftStock } from "./replyInbox";
import { generateDraft, sendRenterReply } from "./replyInbox_actions";
import { draftContextKey } from "./lib/draft_review";
import { canonicalGenerationError, generationFailure } from "./lib/canonical_generation_error";

// Registered handlers, with an in-memory adapter. Managed persistence is checked separately in the Lab.
function database() {
  const rows = new Map<string, any>(); let serial = 0;
  const db = {
    insert: async (table: string, value: any) => { const id = `${table}:${++serial}`; rows.set(id, { ...value, _id: id, _creationTime: serial, table }); return id; },
    patch: async (id: string, value: any) => { const row = { ...rows.get(id) }; for (const [k, v] of Object.entries(value)) { if (v === undefined) delete row[k]; else row[k] = v; } rows.set(id, row); },
    query: (table: string) => {
      const filters: Array<(r: any) => boolean> = []; let descending=false;
      const chain: any = { eq: (key: string, value: any) => { filters.push(r => r[key] === value); return chain; }, gte: (key: string, value: any) => { filters.push(r => r[key] >= value); return chain; } };
      const query: any = { withIndex: (_name: string, select: any) => { select(chain); return query; },
        collect: async () => { const found=[...rows.values()].filter(r => r.table === table && filters.every(f => f(r))); return descending ? found.sort((a,b)=>b._creationTime-a._creationTime) : found; },
        order: (direction:string) => { descending=direction==="desc"; return query; },
        take: async (count:number) => (await query.collect()).slice(0,count),
        first: async () => (await query.collect())[0] ?? null };
      return query;
    },
  };
  return { ctx: { db }, rows };
}
const invoke = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);
describe("copied bot replies use current Native stock before send",()=>{
 async function stockDraft() {
  const f=await setup();await f.ctx.db.patch(f.convId,{account_slug:"leo"});
  const itemId=await f.ctx.db.insert("items",{name_canonical:"Sony FX3",qty:1,status:"active",is_marketing_only:false});
  const text="Sony FX3 is available for 2 to 4 October.";
  const scope={start_date:"2026-10-02",end_date:"2026-10-04",items:[{name:"Sony FX3",quantity:1}]};
  const evidence={model_id:"native-test",stage:"INQUIRY",stock_request:scope,stock:[{item:"Sony FX3",start_date:scope.start_date,end_date:scope.end_date,quantity:1,available:true,free_units:1,checked_at:1,call_id:"original-native"}]};
  await invoke(setDraft,f.ctx,{thread_id:f.args.thread_id,message_id:f.args.message_id,epoch:2,context_key:f.args.context_key,draft_text:text,evidence});
  const approval=await invoke(getDraftApprovalContext,f.ctx,{thread_id:f.args.thread_id});
  return {...f,itemId,text,approval,evidence};
 }
 const recheck=(f:any,text=f.text)=>invoke(recheckCopiedDraftStock,f.ctx,{thread_id:f.args.thread_id,account_slug:"leo",text,draft_approval:f.approval.draft_approval});
 it("rejects a competing confirmed booking created after a previously available draft",async()=>{
  const f=await stockDraft();expect(await recheck(f)).toMatchObject({ok:true});
  await f.ctx.db.insert("reservations",{hygglo_order_id:"competing-rental",status:"confirmed",start_date:"2026-10-02",end_date:"2026-10-04",expanded_items:[{item_id:f.itemId,qty:1}]});
  expect(await recheck(f)).toMatchObject({ok:false,reason:"stock_unverified"});
  expect(await recheck(f,"I can offer the Sony FX3 for 2 to 4 October.")).toMatchObject({ok:false,reason:"stock_unverified"});
  expect(await recheck(f,"Thanks for checking. I'll review the options and get back to you.")).toMatchObject({ok:true});
 });
 it("rechecks catalogue changes and does not borrow old free capacity or changed dates",async()=>{
  const f=await stockDraft();await f.ctx.db.patch(f.itemId,{is_marketing_only:true});
  expect(await recheck(f)).toMatchObject({ok:false});
  await f.ctx.db.patch(f.itemId,{is_marketing_only:false});
  expect(await recheck(f,f.text.replace("2 to 4","5 to 7"))).toMatchObject({ok:false});
  expect(await recheck(f,f.text.replace("Sony FX3","Two Sony FX3 cameras"))).toMatchObject({ok:false});
 });
 it("excludes the requesting booking's own allocation and refreshes negative verdicts too",async()=>{
  const f=await stockDraft();
  await f.ctx.db.insert("reservations",{hygglo_order_id:f.args.thread_id,status:"confirmed",start_date:"2026-10-02",end_date:"2026-10-04",expanded_items:[{item_id:f.itemId,qty:1}]});
  expect(await recheck(f)).toMatchObject({ok:true});
  await f.ctx.db.patch(f.convId,{ai_draft_evidence:{...f.evidence,stock:[{...f.evidence.stock[0],available:false,free_units:0}]}});
  expect(await recheck(f,"Sony FX3 is not available for 2 to 4 October.")).toMatchObject({ok:false});
 });
 it("revalidates inbound/epoch approval inside the stock snapshot",async()=>{
  const f=await stockDraft();await f.ctx.db.patch(f.settingsId,{draft_epoch:3});
  expect(await recheck(f)).toMatchObject({ok:false,reason:"stale_draft"});
 });
 it("does not qualify stock from a legacy draft without the Native request scope",async()=>{
  const f=await stockDraft();const {stock_request,...legacy}=f.evidence;
  await f.ctx.db.patch(f.convId,{ai_draft_evidence:legacy});
  expect(await recheck(f)).toMatchObject({ok:false});
  expect(await recheck(f,"Thank you. I'll check the options.")).toMatchObject({ok:true});
 });
 it("checks copied stock before even dry-run success and fails closed when the check errors",async()=>{
  const f=await stockDraft();
  for(const result of [{ok:false,reason:"stock_unverified"},{ok:true}]) {
   const ctx={runQuery:vi.fn().mockResolvedValueOnce(f.approval).mockResolvedValueOnce(result)};
   expect(await invoke(sendRenterReply,ctx,{thread_id:f.args.thread_id,account_slug:"leo",text:f.text,draft_approval:f.approval.draft_approval,dryRun:true})).toMatchObject(result.ok?{status:"sent",reason:"DRY_RUN"}:{status:"failed",reason:"stock_unverified"});
   expect(ctx.runQuery).toHaveBeenCalledTimes(2);
  }
  const ctx={runQuery:vi.fn().mockResolvedValueOnce(f.approval).mockRejectedValueOnce(new Error("Native check unavailable"))};
  expect(await invoke(sendRenterReply,ctx,{thread_id:f.args.thread_id,account_slug:"leo",text:f.text,dryRun:true})).toMatchObject({status:"failed",reason:"stock_recheck_failed"});
 });
 it("does not attach old bot stock claims to a manually authored reply",async()=>{
  const f=await stockDraft();const ctx={runQuery:vi.fn().mockResolvedValueOnce(f.approval)};
  expect(await invoke(sendRenterReply,ctx,{thread_id:f.args.thread_id,account_slug:"leo",text:"I'll personally check the alternatives.",dryRun:true})).toMatchObject({status:"sent",reason:"DRY_RUN"});
  expect(ctx.runQuery).toHaveBeenCalledTimes(1);
 });
});
describe("canonical generation failure diagnostics",()=>{
 it("preserves upstream timeout identity without exposing request bodies or headers",async()=>{
  const failure=generationFailure({cause:{statusCode:504,isRetryable:true,requestBodyValues:{messages:["private"]},responseHeaders:{authorization:"private"}}},"agent");
  expect(failure).toMatchObject({error:"agent_failed",error_code:"upstream_timeout",upstream_status:504,transient:true});
  const result=await canonicalGenerationError(new Response(JSON.stringify({...failure,detail:"private"}),{status:503,headers:{"x-vercel-id":"iad1::request-one"}}));
  expect(result).toEqual({http_status:503,error_code:"upstream_timeout",upstream_status:504,transient:true,request_id:"iad1::request-one"});
  expect(JSON.stringify(result)).not.toContain("private");
 });
 it("handles HTML failures and never trusts arbitrary returned error codes",async()=>{
  expect(await canonicalGenerationError(new Response("<html>private</html>",{status:502}))).toMatchObject({http_status:502,error_code:"http_failure",transient:false});
  expect(await canonicalGenerationError(new Response(JSON.stringify({error_code:"private",upstream_status:200,detail:"private"}),{status:500}))).toMatchObject({error_code:"http_failure",upstream_status:undefined});
  expect(generationFailure({statusCode:401,isRetryable:false},"agent")).toMatchObject({error_code:"upstream_authorization",transient:false});
 });
});
async function setup() {
  const fixture = database(); const { db } = fixture.ctx; const now = Date.now(); const thread_id = "review-test";
  const convId = await db.insert("conversations", { thread_id, last_sender: "renter", last_msg_at: now, last_renter_msg_at: now, ai_draft_text: "Old preview" });
  const settingsId = await db.insert("settings", { draft_epoch: 2 });
  await db.insert("hygglo_messages", { thread_id, message_id: "renter-1", fetched_at: now, hygglo_sent_at: now });
  const booking = { hygglo_order_id: thread_id, start_date: "2026-10-02", end_date: "2026-10-04", status: "PENDING", items: [{ name: "Sony FX3", qty: 1 }] };
  const bookingId = await db.insert("reservations", booking);
  const args = { thread_id, message_id: "renter-1", epoch: 2, context_key: draftContextKey(booking), stage: "INQUIRY", reason: "needs_human:guard_blocked",
    flags: [{ type: "KIT_HALLUCINATION", detail: "Unverified charger", severity: "critical", action: "flagged" }] };
  return { ...fixture, args, convId, settingsId, bookingId, now };
}
describe("durable review mutations and automatic queue", () => {
  it("regenerates a saved draft when its booking becomes obsolete without a new message", async () => {
    const f=await setup();
    expect(await invoke(setDraft,f.ctx,{thread_id:f.args.thread_id,message_id:f.args.message_id,epoch:2,context_key:f.args.context_key,draft_text:"Helpful answer"})).toMatchObject({ok:true});
    expect(f.rows.get(f.convId).ai_draft_context_key).toBe(f.args.context_key);
    expect(await invoke(threadsNeedingDraft,f.ctx,{limit:20})).toEqual([]);
    await f.ctx.db.patch(f.bookingId,{is_obsolete:true});
    expect(await invoke(threadsNeedingDraft,f.ctx,{limit:20})).toEqual([f.args.thread_id]);
    expect(await invoke(setDraft,f.ctx,{thread_id:f.args.thread_id,message_id:f.args.message_id,epoch:2,context_key:f.args.context_key,draft_text:"Late old answer"})).toMatchObject({ok:false,reason:"stale_context"});
  });
  it("persists reasons, clears the old preview and stops repeated backfill selection", async () => {
    const f = await setup();
    expect(await invoke(threadsNeedingDraft, f.ctx, { limit: 20 })).toEqual([f.args.thread_id]);
    const result = await invoke(setDraftReview, f.ctx, f.args);
    expect(result).toMatchObject({ ok: true, review: { reason: f.args.reason, flags: f.args.flags } });
    expect(f.rows.get(f.convId).ai_draft_text).toBeUndefined();
    for (let n = 0; n < 3; n++) expect(await invoke(threadsNeedingDraft, f.ctx, { limit: 20 })).toEqual([]);
  });
  it("refuses a late blocked result after a new renter message", async () => {
    const f = await setup();
    await f.ctx.db.insert("hygglo_messages", { thread_id: f.args.thread_id, message_id: "renter-2", fetched_at: f.now + 1, hygglo_sent_at: f.now + 1 });
    expect(await invoke(setDraftReview, f.ctx, f.args)).toMatchObject({ ok: false, reason: "stale_inbound" });
    expect(f.rows.get(f.convId).ai_draft_text).toBe("Old preview");
  });
  it("rejects results computed before an order or draft epoch change", async () => {
    for (const target of ["order", "epoch"]) {
      const f = await setup();
      await f.ctx.db.patch(target === "order" ? f.bookingId : f.settingsId, target === "order" ? { end_date: "2026-10-05" } : { draft_epoch: 3 });
      expect(await invoke(setDraftReview, f.ctx, f.args)).toMatchObject({ ok: false });
      expect(await invoke(setDraft, f.ctx, { thread_id: f.args.thread_id, message_id: f.args.message_id, draft_text: "Stale preview", epoch: f.args.epoch, context_key: f.args.context_key })).toMatchObject({ ok: false });
    }
  });
  it("makes changed inbound, order facts and logic eligible again", async () => {
    for (const change of ["inbound", "order", "epoch"]) {
      const f = await setup(); await invoke(setDraftReview, f.ctx, f.args);
      if (change === "inbound") await f.ctx.db.insert("hygglo_messages", { thread_id: f.args.thread_id, message_id: "renter-2", fetched_at: f.now + 1, hygglo_sent_at: f.now + 1 });
      if (change === "order") await f.ctx.db.patch(f.bookingId, { items: [{ name: "Sony FX3", qty: 2 }] });
      if (change === "epoch") await f.ctx.db.patch(f.settingsId, { draft_epoch: 3 });
      expect(await invoke(threadsNeedingDraft, f.ctx, { limit: 20 })).toEqual([f.args.thread_id]);
    }
  });
  it("clears the review only when a current successful draft is saved", async () => {
    const f = await setup(); await invoke(setDraftReview, f.ctx, f.args);
    expect(await invoke(setDraft, f.ctx, { thread_id: f.args.thread_id, message_id: f.args.message_id, epoch: 2, context_key: f.args.context_key, draft_text: "Verified reply" })).toMatchObject({ ok: true });
    expect(f.rows.get(f.convId).ai_draft_review).toBeUndefined();
    expect(await invoke(threadsNeedingDraft, f.ctx, { limit: 20 })).toEqual([]);
  });
  it("returns the saved review on another generation call without invoking a model", async () => {
    const f = await setup(); const saved = await invoke(setDraftReview, f.ctx, f.args);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("provider must not be called"));
    const ctx = { runAction: vi.fn().mockResolvedValue({}), runQuery: vi.fn().mockResolvedValue({ draft_review: saved.review, draft_epoch: 2, draft_context_key: f.args.context_key, last_message_id: f.args.message_id }), runMutation: vi.fn().mockResolvedValue({ok:true}) };
    try {
      expect(await invoke(generateDraft, ctx, { thread_id: "__probe__review-test" })).toMatchObject({ status: "skipped", review: saved.review, flags: f.args.flags });
      expect(fetchSpy).not.toHaveBeenCalled(); expect(ctx.runMutation).toHaveBeenCalledTimes(2);
    } finally { fetchSpy.mockRestore(); }
  });
});


describe("managed generation ownership", () => {
  it("blocks real chats before leasing, context reads or provider calls without written rollout consent", async () => {
    const ctx={runMutation:vi.fn(),runQuery:vi.fn(),runAction:vi.fn()};
    expect(await invoke(generateDraft,ctx,{thread_id:"real-rental"})).toEqual({status:"skipped",reason:"lab_only_pending_written_consent"});
    expect(ctx.runMutation).not.toHaveBeenCalled();expect(ctx.runQuery).not.toHaveBeenCalled();expect(ctx.runAction).not.toHaveBeenCalled();
  });
  it("rejects overlap and an expired owner's release cannot remove its replacement", async () => {
    const f = await setup();
    expect(await invoke(claimDraftGeneration, f.ctx, {thread_id:f.args.thread_id,token:"first"})).toEqual({ok:true});
    expect(await invoke(claimDraftGeneration, f.ctx, {thread_id:f.args.thread_id,token:"second"})).toMatchObject({ok:false,reason:"generation_in_progress"});
    await f.ctx.db.patch(f.convId,{ai_draft_generation_until:Date.now()-1});
    expect(await invoke(claimDraftGeneration,f.ctx,{thread_id:f.args.thread_id,token:"replacement"})).toEqual({ok:true});
    expect(await invoke(releaseDraftGeneration,f.ctx,{thread_id:f.args.thread_id,token:"first"})).toEqual({ok:false});
    expect(f.rows.get(f.convId).ai_draft_generation_token).toBe("replacement");
    expect(await invoke(releaseDraftGeneration,f.ctx,{thread_id:f.args.thread_id,token:"replacement"})).toEqual({ok:true});
    expect(await invoke(claimDraftGeneration,f.ctx,{thread_id:f.args.thread_id,token:"third"})).toEqual({ok:true});
  });
  it("does not resolve context or call a model when another generation owns the thread", async () => {
    const ctx={runMutation:vi.fn().mockResolvedValue({ok:false,reason:"generation_in_progress"}),runQuery:vi.fn(),runAction:vi.fn()};
    expect(await invoke(generateDraft,ctx,{thread_id:"__probe__busy-thread"})).toMatchObject({status:"skipped",reason:"generation_in_progress"});
    expect(ctx.runQuery).not.toHaveBeenCalled();expect(ctx.runAction).not.toHaveBeenCalled();expect(ctx.runMutation).toHaveBeenCalledTimes(1);
  });
  it("releases its own claim after a context failure so a corrected retry can run", async () => {
    const failure=new Error("context unavailable");
    const ctx={runMutation:vi.fn().mockResolvedValue({ok:true}),runQuery:vi.fn().mockRejectedValue(failure),runAction:vi.fn().mockResolvedValue({})};
    await expect(invoke(generateDraft,ctx,{thread_id:"__probe__failure-thread"})).rejects.toThrow("context unavailable");
    expect(ctx.runMutation).toHaveBeenCalledTimes(2);
    expect(ctx.runMutation.mock.calls[1][1]).toEqual(ctx.runMutation.mock.calls[0][1]);
  });
});


describe("operational conversation stage storage",()=>{
 it("storage accepts the same stage vocabulary as structured model output",()=>{
  const stored=schema.tables.conversations.validator.fields.conversation_stage.members.map(member=>member.value);
  expect(stored).toEqual([...CONVERSATION_STAGES]);
  for(const stage of stored)expect(validateRenterBotOutput({draft:"A reply",intent:"GENERAL",conversation_stage:stage,red_flags:[],factsClaimed:[],needs_human:false})).not.toBeNull();
  expect(validateRenterBotOutput({draft:"A reply",intent:"GENERAL",conversation_stage:"invented",red_flags:[],factsClaimed:[],needs_human:false})).toBeNull();
 });
 for(const [status,order_step,expected] of [["confirmed","BOOKED_AFTER_VERIFIED","CONFIRMED_UPCOMING"],["pending_review","VERIFIED","AWAITING_VERIFICATION"],["cancelled","VERIFICATION_FAILED","VERIFICATION_FAILED"]]){
  it(`stores current Native ${expected} rather than an incoming stale sales label`,async()=>{
   const f=await setup();await f.ctx.db.patch(f.bookingId,{status,order_step,start_date:"2099-10-20",end_date:"2099-10-21"});
   const key=draftContextKey(f.rows.get(f.bookingId));
   expect(await invoke(setDraft,f.ctx,{thread_id:f.args.thread_id,message_id:f.args.message_id,epoch:2,context_key:key,conversation_stage:"INQUIRY",draft_text:"A helpful stage-aware reply"})).toMatchObject({ok:true});
   expect(f.rows.get(f.convId).conversation_stage).toBe(expected);
  });
 }
 it("retains sales stages when no booking exists",async()=>{
  const f=await setup();f.rows.delete(f.bookingId);
  expect(await invoke(setDraft,f.ctx,{thread_id:f.args.thread_id,message_id:f.args.message_id,epoch:2,context_key:draftContextKey(null),conversation_stage:"INTERESTED",draft_text:"A helpful inquiry reply"})).toMatchObject({ok:true});
  expect(f.rows.get(f.convId).conversation_stage).toBe("INTERESTED");
 });
});


describe("owner checks preserve unresolved work in bot context",()=>{
 const check={requirements:{focus_mode:"autofocus"},lens_mount:"E",start_date:"2026-10-20",end_date:"2026-10-21",quantity:1};
 const task=(status:string,thread_id="lab-one",context="current")=>({thread_id,status,check,candidate_names:["Sony lens"],source_context_key:context,source_message_id:"message",handling_note:"Private owner note"});
 it("keeps an old pending question after more than twenty newer handled checks",async()=>{
  const {ctx}=database();const pendingId=await ctx.db.insert("renter_bot_owner_checks",task("pending"));
  for(let i=0;i<25;i++)await ctx.db.insert("renter_bot_owner_checks",task("handled_by_owner"));
  await ctx.db.insert("renter_bot_owner_checks",task("pending","other-thread"));
  const checks=await ownerChecksForBot(ctx as any,"lab-one","current");
  expect(checks).toHaveLength(21);expect(checks[0]).toMatchObject({task_id:pendingId,status:"pending",context_changed:false,specification_result_verified:false,customer_input_required:false});
  expect(checks.filter(c=>c.status==="handled_by_owner")).toHaveLength(20);
  expect(JSON.stringify(checks)).not.toContain("Private owner note");
 });
 it("retains every pending scope and marks old basket context without borrowing approval",async()=>{
  const {ctx}=database();
  for(let i=0;i<23;i++)await ctx.db.insert("renter_bot_owner_checks",task("pending","lab-one",i===0?"old":"current"));
  const checks=await ownerChecksForBot(ctx as any,"lab-one","current");
  expect(checks).toHaveLength(23);expect(checks.filter(c=>c.context_changed)).toHaveLength(1);
  expect(checks.every(c=>!c.specification_result_verified&&!c.customer_input_required)).toBe(true);
 });
});
