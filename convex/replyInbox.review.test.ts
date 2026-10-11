import {budgetPriceCheckText} from "./lib/budget_price_check";
import {replacementValueComparisonText} from "./lib/replacement_value_comparison";
import {sendTestMessage} from "./renter_bot_lab_actions";
import {insertRun} from "./renter_bot_harness";
import {getFunctionName} from "convex/server";
import {getAll as getOverrides,getRevision as getMappingRevision,setOverride,remove as removeOverride} from "./listing_overrides";
import {loadListingInventory} from "./lib/listing_inventory";
import {getReview as getCameraReview,saveReview as saveCameraReview} from "./renter_bot_camera_reviews";
import {verifiedCameraCapabilities} from "./lib/camera_requirements";
import {computeNegotiationStance,negotiationFromMessages} from "./lib/renter_bot_negotiation";
import {rentalRequestContext,rentalRequestHistory} from "./lib/rental_request_history";
import type {Id} from "./_generated/dataModel";
import {getLensReview,reviewLensSpecification,handle as handleOwnerCheck, ownerChecksForBot } from "./renter_bot_owner_checks";
import {ownerCheckScopeKey, nativeOwnerChecks } from "./lib/owner_checks";
import schema from "./schema";
import { CONVERSATION_STAGES } from "./lib/renter_bot_intents";
import { validateRenterBotOutput } from "../src/lib/renter-bot-output";
import { describe, expect, it, vi } from "vitest";
import { setDraftReview, setDraft, threadsNeedingDraft, claimDraftGeneration, releaseDraftGeneration, getDraftApprovalContext, recheckCopiedDraftStock } from "./replyInbox";
import { generateDraft, sendRenterReply } from "./replyInbox_actions";
import {get_renter_context,select_rental_request,performJointStockCheck,check_availability,get_negotiation_stance,get_listing_context,find_owned_alternatives,__service_basket_replacement_candidates,lookup_pricing} from './renter_bot_tools';
import { draftContextKey } from "./lib/draft_review";
import { canonicalGenerationError, generationFailure } from "./lib/canonical_generation_error";

// Registered handlers, with an in-memory adapter. Managed persistence is checked separately in the Lab.
function database() {
  const rows = new Map<string, any>(); let serial = 0;
  const db = {
    get: async (id:string) => rows.get(id)??null,
    normalizeId:(table:string,id:string)=>rows.get(id)?.table===table?id:null,
    delete: async (id:string) => {rows.delete(id);},
    insert: async (table: string, value: any) => { const id = `${table}:${++serial}`; rows.set(id, { ...value, _id: id, _creationTime: serial, table }); return id; },
    patch: async (id: string, value: any) => { const row = { ...rows.get(id) }; for (const [k, v] of Object.entries(value)) { if (v === undefined) delete row[k]; else row[k] = v; } rows.set(id, row); },
    query: (table: string) => {
      const filters: Array<(r: any) => boolean> = []; let descending=false;
      const chain: any = { eq: (key: string, value: any) => { filters.push(r => r[key] === value); return chain; }, gte: (key: string, value: any) => { filters.push(r => r[key] >= value); return chain; } };
      const query: any = { withIndex: (_name: string, select: any) => { select(chain); return query; },
        collect: async () => { const found=[...rows.values()].filter(r => r.table === table && filters.every(f => f(r))); return descending ? found.sort((a,b)=>b._creationTime-a._creationTime) : found; },
        order: (direction:string) => { descending=direction==="desc"; return query; },
        take: async (count:number) => (await query.collect()).slice(0,count),
        first: async () => (await query.collect())[0] ?? null,
        unique: async () => {const found=await query.collect();if(found.length>1)throw new Error("Duplicate rows");return found[0]??null;} };
      return query;
    },
  };
  return { ctx: { db }, rows };
}
const invoke = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);
describe("Quick Reply qualified replacement search limit", () => {
 it("continues beyond six unmapped candidates to verified account listings without writes", async () => {
  const f=database();
  await f.ctx.db.insert("items",{name_canonical:"Manfrotto 055",kind:"tripod",status:"active",qty:10,replacement_cost_gbp:1000});
  for(let n=0;n<6;n++)await f.ctx.db.insert("items",{name_canonical:`Manfrotto 190 alternative ${n}`,kind:"tripod",status:"active",qty:10,replacement_cost_gbp:500});
  for(let n=0;n<2;n++){
   const name=`Basic Tripod ${n}`,pid=700+n;
   const id=await f.ctx.db.insert("items",{name_canonical:name,kind:"tripod",status:"active",qty:10,replacement_cost_gbp:500});
   await f.ctx.db.insert("online_listings",{account_slug:"leo",product_id:pid,name,description:`Included in this kit: • 1x ${name}`,daily_price:10});
   await f.ctx.db.insert("listing_resolution_override",{account_slug:"leo",product_id:pid,components:[{item_id:id,qty:1}]});
   await f.ctx.db.insert("hygglo_products",{accountSlug:"leo",productId:pid,masterItemId:id,prices:[{days:1,pricePerDay:10}]});
  }
  const args={account_slug:"leo",item_name:"Manfrotto 055",exclude_name:"Manfrotto 055",start_date:"2026-10-20",end_date:"2026-10-21",quantity:1,booking_use:"standalone"};
  const publicResult=await invoke(find_owned_alternatives,f.ctx,args);
  expect(publicResult.alternatives).toHaveLength(6);
  expect(publicResult.alternatives.every((a:any)=>!a.mapping_complete)).toBe(true);
  const before=JSON.stringify([...f.rows]);
  const result=await invoke(__service_basket_replacement_candidates,f.ctx,args);
  expect(result.alternatives.map((a:any)=>a.product_id)).toEqual([700,701]);
  expect(result.alternatives.every((a:any)=>a.mapping_complete&&a.availability.available===true&&!a.storage_contents_verification_required)).toBe(true);
  expect(JSON.stringify([...f.rows])).toBe(before);
 });
});

describe("Identity-backed complete listing replacements", () => {
 async function fixture(){
  const f=database();const ids:any={};
  for(const [pid,name,units,cost,mount] of [[10,"Manfrotto 055",2,1000,"E"],[20,"Manfrotto 190",1,500,"E"],[21,"Basic Tripod",2,400,"E"],[22,"Light Tripod",2,300,"E"],[23,"Expensive Tripod",2,1200,"E"],[24,"Wrong Mount Tripod",2,200,"EF"]] as const){
   const id=await f.ctx.db.insert("items",{name_canonical:name,kind:"tripod",lens_mount:mount,status:"active",qty:10,replacement_cost_gbp:cost});ids[pid]=id;
   await f.ctx.db.insert("online_listings",{account_slug:"leo",product_id:pid,name:`Operator kit ${pid} - collected fully assembled`,description:`Included in this kit: • ${units}x ${name}`,daily_price:10});
   await f.ctx.db.insert("listing_resolution_override",{account_slug:"leo",product_id:pid,components:[{item_id:id,qty:units}]});
   await f.ctx.db.insert("hygglo_products",{accountSlug:"leo",productId:pid,masterItemId:id,name:`Operator kit ${pid}`,prices:[{days:1,pricePerDay:10}]});
  }
  const args={account_slug:"leo",target_product_id:10,item_name:"Operator kit - collected fully assembled",exclude_name:"Operator kit - collected fully assembled",quantity:1,start_date:"2026-10-20",end_date:"2026-10-21",booking_use:"standalone"};
  return {...f,ids,args};
 }
 it("uses exact listing identity despite unmatchable titles and preserves both requested units", async()=>{
  const f=await fixture(),before=JSON.stringify([...f.rows]);
  const result=await invoke(__service_basket_replacement_candidates,f.ctx,f.args);
  expect(result.alternatives.map((a:any)=>a.product_id).sort()).toEqual([21,22]);
  expect(result.alternatives.every((a:any)=>a.mapping_complete&&a.availability.available)).toBe(true);
  expect(JSON.stringify([...f.rows])).toBe(before);
 });
 it("keeps source value unknown rather than borrowing a fuzzy title match", async()=>{
  const f=await fixture();await f.ctx.db.patch(f.ids[10],{replacement_cost_gbp:undefined});
  const result=await invoke(__service_basket_replacement_candidates,f.ctx,f.args);
  expect(result.alternatives).toEqual([]);expect(result.reason).toContain("replacement value");
 });
 it("does not use another account's listing identity", async()=>{
  const f=await fixture();const result=await invoke(__service_basket_replacement_candidates,f.ctx,{...f.args,account_slug:"foreign"});
  expect(result.alternatives).toEqual([]);expect(result.reason).toContain("mapping");
 });
 it("checks candidates with the retained kit and excludes existing booking listings", async()=>{
  const f=await fixture();const result=await invoke(__service_basket_replacement_candidates,f.ctx,{...f.args,basket_lines:[{name:"Original",qty:1,product_id:10},{name:"Retained",qty:1,product_id:21}],omit_product_ids:[10]});
  expect(result.alternatives.map((a:any)=>a.product_id)).toEqual([22]);
 });
});

describe("Native independent hire budget qualification",()=>{
 async function fixture(){
  const f=database();const ids:any={};
  for(const [name,pid,rate,marketing] of [["Sony FX3",10,49,false],["Sony A7 V",20,42,false],["Sony A7 III",30,28,false],["Canon R5",40,10,true]] as const){
   const id=await f.ctx.db.insert("items",{name_canonical:name,kind:"camera",lens_mount:"E",status:"active",qty:10,is_marketing_only:marketing});ids[name]=id;
   await f.ctx.db.insert("online_listings",{account_slug:"leo",product_id:pid,name,description:`Included in this kit: • 1x ${name}`,daily_price:rate});
   await f.ctx.db.insert("listing_resolution_override",{account_slug:"leo",product_id:pid,components:[{item_id:id,qty:1}]});
   await f.ctx.db.insert("hygglo_products",{accountSlug:"leo",productId:pid,masterItemId:id,prices:[{days:1,pricePerDay:rate}]});
   const proof={verified_model:name,source_url:"https://manufacturer.example/mode",verified_at:1};
   await f.ctx.db.insert("item_specs",{item_name_canonical:name,item_id:id,source:"manufacturer-verified",...proof,
    camera_capabilities:{...proof,role:"interchangeable_lens",native_mount:"E",sensor_format:"full_frame",internal_4k:true,
     recording_modes:[{...proof,resolution:"uhd_4k",nominal_fps:[30],capture_format:"full_frame",full_width:true,internal:true,conditions:[]}]}});
  }
  const args={account_slug:"leo",kind:"camera",item_name:"Sony FX3",lens_mount:"E",camera_requirements:{sensor_format:"full_frame",recording:{resolution:"uhd_4k",min_fps:30,full_width:true,internal:true}},start_date:"2026-10-20",end_date:"2026-10-21",quantity:1,booking_use:"standalone",max_rental_total_gbp:65};
  return {...f,ids,args};
 }
 it("resolves a long camera-kit title through its product identity without dropping the second body", async()=>{
  const f=await fixture();
  for(const row of f.rows.values())if(row.table==="items")await f.ctx.db.patch(row._id,{replacement_cost_gbp:row.name_canonical==="Sony FX3"?2500:1000});
  const original=[...f.rows.values()].find(row=>row.table==="listing_resolution_override"&&row.product_id===10);
  await f.ctx.db.patch(original._id,{components:[{item_id:f.ids["Sony FX3"],qty:2}]});
  for(const [pid,name] of [[21,"Sony A7 V"],[31,"Sony A7 III"]] as const){
   await f.ctx.db.insert("online_listings",{account_slug:"leo",product_id:pid,name:`Two-body ${name} pack`,description:`Included in this kit: • 2x ${name}`,daily_price:40});
   await f.ctx.db.insert("listing_resolution_override",{account_slug:"leo",product_id:pid,components:[{item_id:f.ids[name],qty:2}]});
   await f.ctx.db.insert("hygglo_products",{accountSlug:"leo",productId:pid,masterItemId:f.ids[name],name:`Two-body ${name} pack`,prices:[{days:1,pricePerDay:40}]});
  }
  const before=JSON.stringify([...f.rows]);
  const result=await invoke(__service_basket_replacement_candidates,f.ctx,{account_slug:"leo",target_product_id:10,item_name:"Production collection pack with batteries and accessories",start_date:"2026-10-20",end_date:"2026-10-21",quantity:1,booking_use:"standalone"});
  expect(result.alternatives.map((a:any)=>a.product_id).sort()).toEqual([21,31]);
  expect(JSON.stringify([...f.rows])).toBe(before);
 });
 it("quick reply infers camera requirements without also requiring a lens",async()=>{
  const f=await fixture();
  for(const row of f.rows.values())if(row.table==="items")await f.ctx.db.patch(row._id,{replacement_cost_gbp:row.name_canonical==="Sony FX3"?2500:1000});
  const {max_rental_total_gbp,booking_use,camera_requirements,...args}=f.args;
  const result=await invoke(__service_basket_replacement_candidates,f.ctx,args);
  expect(result.alternatives.map((a:any)=>a.name)).toEqual(expect.arrayContaining(["Sony A7 V","Sony A7 III"]));
  expect(result.lens_requirements_specified).toBe(false);
  expect(result.alternatives.some((a:any)=>a.name==="Canon R5")).toBe(false);
  // The old caller supplied both empty requirement objects, requiring a camera to also be a lens.
  const contradictory=await invoke(find_owned_alternatives,f.ctx,{...args,camera_requirements:{},lens_requirements:{}});
  expect(contradictory.alternatives).toEqual([]);
 });
 it("basket replacement uses the freshly read order identities and omits all unavailable originals",async()=>{
  const f=await fixture();
  for(const row of f.rows.values())if(row.table==="items")await f.ctx.db.patch(row._id,{replacement_cost_gbp:row.name_canonical==="Sony FX3"?2500:1000});
  const booking=await f.ctx.db.insert("reservations",{hygglo_order_id:"basket-thread",account_slug:"leo",status:"confirmed",start_date:"2026-10-20",end_date:"2026-10-21",hygglo_items:[{name:"Sony FX3",qty:1},{name:"Unavailable lens",qty:1}]});
  const {max_rental_total_gbp,booking_use,camera_requirements,...args}=f.args;
  const query={...args,thread_id:"basket-thread",booking_use:"replacement",omit_product_ids:[10,99]};
  expect((await invoke(__service_basket_replacement_candidates,f.ctx,query)).alternatives).toEqual([]);
  const fresh={...query,basket_lines:[{name:"Sony FX3",qty:1,product_id:10},{name:"Unavailable lens",qty:1,product_id:99}]};
  const options=await invoke(__service_basket_replacement_candidates,f.ctx,fresh);
  expect(options.alternatives.length).toBeGreaterThan(0);
  expect(options.alternatives.every((item:any)=>item.availability?.available===true)).toBe(true);
  await f.ctx.db.patch(booking,{status:"cancelled"});
  expect((await invoke(__service_basket_replacement_candidates,f.ctx,fresh)).alternatives).toEqual([]);
 });
 it("filters a verified over-budget offer while retaining an exactly priced suitable alternative",async()=>{
  const f=await fixture(),r=await invoke(find_owned_alternatives,f.ctx,f.args);
  expect(r.alternatives.map((a:any)=>[a.name,a.quote.listed_total_gbp])).toEqual([["Sony A7 III",56]]);
  expect(r).toMatchObject({budget_outcome:"verified_matches",budget_price_scope:"independent_candidate_hire",rejected:{budget_over_limit:1}});
  expect(r.rejected_budget_options).toEqual([{item_id:f.ids["Sony A7 V"],name:"Sony A7 V",total_gbp:84,product_id:20}]);
  expect(r.alternatives.some((a:any)=>a.name==="Canon R5")).toBe(false);
 });
 it("applies exact duration tiers and quantity rather than a daily-price shortcut",async()=>{
  const f=await fixture();const hp=[...f.rows.values()].find(r=>r.table==="hygglo_products"&&r.productId===20);
  await f.ctx.db.patch(hp._id,{prices:[{days:1,pricePerDay:42},{days:3,pricePerDay:21}]});
  const r=await invoke(find_owned_alternatives,f.ctx,{...f.args,end_date:"2026-10-22"});
  expect(r.alternatives.map((a:any)=>[a.name,a.quote.listed_total_gbp])).toEqual([["Sony A7 V",63]]);
  expect((await invoke(find_owned_alternatives,f.ctx,{...f.args,quantity:2})).alternatives).toEqual([]);
 });
 it("keeps unknown price and recording facts explicit and opens specification review",async()=>{
  const f=await fixture();
  for(const row of f.rows.values())if(row.table==="hygglo_products"&&row.productId===30)await f.ctx.db.patch(row._id,{prices:[]});
  for(const row of f.rows.values())if(row.table==="online_listings"&&row.product_id===30)await f.ctx.db.patch(row._id,{daily_price:undefined});
  for(const row of f.rows.values())if(row.table==="item_specs"&&row.item_id===f.ids["Sony A7 III"])await f.ctx.db.patch(row._id,{camera_capabilities:{...row.camera_capabilities,recording_modes:[]}});
  const r=await invoke(find_owned_alternatives,f.ctx,f.args);
  expect(r.alternatives).toEqual([]);expect(r.budget_outcome).toBe("needs_review");
  expect(r.budget_price_review_needed).toEqual([{item_id:f.ids["Sony A7 III"],name:"Sony A7 III",product_id:null}]);
  expect(r.owner_check).toMatchObject({kind:"camera_recommendation",candidate_item_ids:[f.ids["Sony A7 III"]]});
  // A correct specification does not invent the missing rental total.
  for(const row of f.rows.values())if(row.table==="item_specs"&&row.item_id===f.ids["Sony A7 III"])await f.ctx.db.patch(row._id,{camera_capabilities:{...row.camera_capabilities,recording_modes:[{verified_model:"Sony A7 III",source_url:"https://manufacturer.example/mode",verified_at:1,resolution:"uhd_4k",nominal_fps:[30],capture_format:"full_frame",full_width:true,internal:true,conditions:[]}]}});
  expect((await invoke(find_owned_alternatives,f.ctx,f.args)).alternatives).toEqual([]);
 });
 it("cannot turn a candidate price into an amended-basket total or use invalid scope",async()=>{
  const f=await fixture();expect(await invoke(find_owned_alternatives,f.ctx,{...f.args,booking_use:"replacement"})).toMatchObject({budget_outcome:"joint_quote_required",alternatives:[]});
  for(const changed of [{start_date:undefined},{end_date:"2026-02-30"},{quantity:0},{max_rental_total_gbp:-1}])
   expect(await invoke(find_owned_alternatives,f.ctx,{...f.args,...changed})).toMatchObject({budget_outcome:"invalid_budget_scope",alternatives:[]});
 });
});

describe("current Native budget information at copied-reply approval",()=>{
 async function fixture(){
  const f=await setup();await f.ctx.db.patch(f.convId,{account_slug:"leo"});await f.ctx.db.patch(f.bookingId,{account_slug:"leo"});
  const item=await f.ctx.db.insert("items",{name_canonical:"Sony FX3",kind:"camera",status:"active",qty:1,is_marketing_only:false});
  const listing=await f.ctx.db.insert("online_listings",{account_slug:"leo",product_id:10,name:"Sony FX3",description:"Included in this kit: • 1x Sony FX3",daily_price:49});
  const mapping=await f.ctx.db.insert("listing_resolution_override",{account_slug:"leo",product_id:10,components:[{item_id:item,qty:1}]});
  const hp=await f.ctx.db.insert("hygglo_products",{accountSlug:"leo",productId:10,masterItemId:item,prices:[{days:1,pricePerDay:49}]});
  const proof={budget_key:"budget_"+"a".repeat(32),start_date:"2026-10-20",end_date:"2026-10-21",quantity:1,max_total_gbp:65,prices:[{item_id:item,name:"Sony FX3",product_id:10,total_gbp:98}]};
  const text=budgetPriceCheckText(proof)!;
  await invoke(setDraft,f.ctx,{thread_id:f.args.thread_id,message_id:f.args.message_id,epoch:2,context_key:f.args.context_key,draft_text:text,evidence:{model_id:"native",stage:"INQUIRY",stock:[],budget_price_checks:[proof]}});
  const approval=await invoke(getDraftApprovalContext,f.ctx,{thread_id:f.args.thread_id});
  return {...f,item,listing,mapping,hp,proof,text,approval:approval.draft_approval};
 }
 const check=(f:any,text=f.text)=>invoke(recheckCopiedDraftStock,f.ctx,{thread_id:f.args.thread_id,account_slug:"leo",text,draft_approval:f.approval});
 it("explains the search maximum and rejected price without creating stock or hire authority",async()=>{
  const f=await fixture(),before={...f.rows.get(f.bookingId)};
  expect(await check(f)).toMatchObject({ok:true});
  expect(f.rows.get(f.convId).ai_draft_evidence.stock_quotes).toBeUndefined();
  expect(f.rows.get(f.bookingId)).toEqual(before);
  for(const text of [f.text.replace("£65","£66"),f.text.replace("£98","£980"),f.text+"\nAvailable for your dates",f.text+"\n  Available for your dates",f.text+"\nI can offer it for £60"])
   expect(await check(f,text),text).toMatchObject({ok:false});
 });
 it("rechecks current exact account tier prices and physical eligibility",async()=>{
  for(const change of ["price","mapping","marketing","inactive","account"]){
   const f=await fixture();
   if(change==="price")await f.ctx.db.patch(f.hp,{prices:[{days:1,pricePerDay:48}]});
   if(change==="mapping")await f.ctx.db.patch(f.mapping,{components:[{item_id:"unknown",qty:1}]});
   if(change==="marketing")await f.ctx.db.patch(f.item,{is_marketing_only:true});
   if(change==="inactive")await f.ctx.db.patch(f.item,{status:"inactive"});
   if(change==="account")await f.ctx.db.patch(f.listing,{account_slug:"diogo"});
   expect(await check(f)).toMatchObject({ok:false,reason:"budget_price_unverified"});
  }
 });
 it("does not borrow a single-unit price for a longer or larger hire",async()=>{
  for(const changes of [{quantity:2},{end_date:"2026-10-22"}]){
   const f=await fixture(),proof={...f.proof,...changes},text=budgetPriceCheckText(proof)!;
   await f.ctx.db.patch(f.convId,{ai_draft_text:text,ai_draft_evidence:{model_id:"native",stage:"INQUIRY",stock:[],budget_price_checks:[proof]}});
   expect(await check(f,text)).toMatchObject({ok:false,reason:"budget_price_unverified"});
  }
 });
});

describe("current Native replacement values at copied-reply approval",()=>{
 async function fixture(){
  const f=await setup();await f.ctx.db.patch(f.convId,{account_slug:"leo"});await f.ctx.db.patch(f.bookingId,{account_slug:"leo"});
  const original=await f.ctx.db.insert("items",{name_canonical:"Sony FX3",kind:"camera",status:"active",qty:1,is_marketing_only:false,replacement_cost_gbp:3300});
  const alternative=await f.ctx.db.insert("items",{name_canonical:"Sony A7 V",kind:"camera",status:"active",qty:1,is_marketing_only:false,replacement_cost_gbp:2200});
  const comparison={value_key:"value_"+"a".repeat(32),original:{item_id:original,name:"Sony FX3",value_gbp:3300},alternative:{item_id:alternative,name:"Sony A7 V",value_gbp:2200}};
  const text=replacementValueComparisonText(comparison)!;
  await invoke(setDraft,f.ctx,{thread_id:f.args.thread_id,message_id:f.args.message_id,epoch:2,context_key:f.args.context_key,draft_text:text,evidence:{model_id:"native",stage:"INQUIRY",stock:[],replacement_value_comparisons:[comparison]}});
  const approval=await invoke(getDraftApprovalContext,f.ctx,{thread_id:f.args.thread_id});
  return {...f,original,alternative,text,comparison,approval:approval.draft_approval};
 }
 const check=(f:any,text=f.text)=>invoke(recheckCopiedDraftStock,f.ctx,{thread_id:f.args.thread_id,account_slug:"leo",text,draft_approval:f.approval});
 it("approves information without creating a hire offer and refuses edited numbers",async()=>{
  const f=await fixture();expect(await check(f)).toMatchObject({ok:true});
  expect(await check(f,f.text.replace("£2,200","£2,100"))).toMatchObject({ok:false});
  expect(f.rows.get(f.convId).ai_draft_evidence.stock_quotes).toBeUndefined();
  expect(f.rows.get(f.bookingId).status).toBe("PENDING");
 });
 it("does not validate a longer value through its canonical amount prefix",async()=>{
  const f=await fixture();
  expect(await check(f,f.text+"0")).toMatchObject({ok:false});
 });
 it("refuses changed values, unknown items and marketing items against current catalogue rows",async()=>{
  for(const changes of [{replacement_cost_gbp:2100},{replacement_cost_gbp:null},{is_marketing_only:true},{status:"inactive"},{qty:0},{name_canonical:"Different physical camera"}]){
   const f=await fixture();await f.ctx.db.patch(f.alternative,changes);expect(await check(f)).toMatchObject({ok:false,reason:"replacement_value_unverified"});
  }
  const f=await fixture();await f.ctx.db.delete(f.original);expect(await check(f)).toMatchObject({ok:false,reason:"replacement_value_unverified"});
 });
});
describe("Native earlier hire descriptions",()=>{
 const request={kind:"inquiry",origin_message_id:"landscape-hire"} as const;
 const origin={message_id:request.origin_message_id,sender:"renter",rental_request:request,body_text:"Sony 16-35mm for landscapes on 22 to 24 October.",hygglo_sent_at:1};
 it("describes the actual served renter origin after its prose leaves the chat window",()=>{
  const messages=[origin,...Array.from({length:60},(_,i)=>({message_id:`later-${i}`,sender:"owner",body_text:"Collection can wait for confirmation."}))];
  expect(rentalRequestHistory(messages)).toEqual([{...request,history:{context_only:true,original_request_text:origin.body_text,original_request_text_truncated:false,original_request_at:1,latest_offered_options:[]}}]);
 });
 it("retains exact last offered dates and listing members without minting financial or stock proof",()=>{
  const quote={quote_key:"old-native",rental_request:request,start_date:"2099-10-22",end_date:"2099-10-24",items:[],listing_quote:{total_gbp:50,lines:[{product_id:123,name:"Sony lens",quantity:1,total_gbp:50}]}};
  const owner=(q:any)=>({message_id:"owner",sender:"owner",rental_request:request,body_text:"Here is the offer.",quoted_inquiries:[{context_key:"old-context",epoch:1,quoted_for_message_id:origin.message_id,quote:q}]});
  const updated={...quote,end_date:"2099-10-28",listing_quote:{...quote.listing_quote,total_gbp:100}};
  const history=rentalRequestHistory([origin,owner(quote),owner(updated)])[0].history;
  expect(history.latest_offered_options).toEqual([{start_date:"2099-10-22",end_date:"2099-10-28",items:[{product_id:123,name:"Sony lens",quantity:1}]}]);
  expect(history).not.toHaveProperty("quote_key");expect(history.latest_offered_options[0]).not.toHaveProperty("total_gbp");
  const foreign={...quote,rental_request:{kind:"inquiry",origin_message_id:"different-hire"}};
  expect(rentalRequestHistory([origin,owner(quote),owner(foreign)])[0].history.latest_offered_options[0].end_date).toBe("2099-10-24");
 });
 it("does not invent earlier hires from an owner tag, a mismatched origin, or untagged renter prose",()=>{
  expect(rentalRequestHistory([{...origin,sender:"owner"},{...origin,message_id:"other"},{...origin,rental_request:undefined}])).toEqual([]);
 });
 it("marks bounded historical excerpts rather than pretending the whole request was supplied",()=>{
  const text="Sony lens. ".repeat(100),history=rentalRequestHistory([{...origin,body_text:text}])[0].history;
  expect(history.original_request_text).toBe(text.slice(0,512));expect(history.original_request_text_truncated).toBe(true);
  expect(rentalRequestContext([{...origin,body_text:text}],request)?.original_request_text).toBe(text);
  expect(rentalRequestContext([origin],{kind:"primary"})).toBeNull();
  expect(rentalRequestContext([{...origin,sender:"owner"}],request)).toBeNull();
 });
});
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
 async function inquiryStockDraft() {
  const f=await stockDraft();
  await f.ctx.db.patch(f.bookingId,{is_obsolete:true});
  f.args.thread_id="__probe__price-review";
  await f.ctx.db.patch(f.convId,{thread_id:f.args.thread_id});
  for(const row of f.rows.values())if(row.table==="hygglo_messages")await f.ctx.db.patch(row._id,{thread_id:f.args.thread_id});
  f.args.context_key=draftContextKey(null);
  return f;
 }
 const recheck=(f:any,text=f.text)=>invoke(recheckCopiedDraftStock,f.ctx,{thread_id:f.args.thread_id,account_slug:"leo",text,draft_approval:f.approval.draft_approval});
 async function independentQuestion(){
  const f=await stockDraft();await f.ctx.db.patch(f.bookingId,{status:"confirmed"});
  for(const row of f.rows.values())if(row.table==="hygglo_messages")await f.ctx.db.patch(row._id,{sender:"renter",body_text:"Can I start another separate rental?"});
  f.args.context_key=draftContextKey(f.rows.get(f.bookingId));
  const request={kind:"inquiry",origin_message_id:f.args.message_id};
  await invoke(setDraft,f.ctx,{thread_id:f.args.thread_id,message_id:f.args.message_id,epoch:2,context_key:f.args.context_key,draft_text:"I can check your new request.",evidence:{...f.evidence,rental_request:request}});
  f.approval=await invoke(getDraftApprovalContext,f.ctx,{thread_id:f.args.thread_id});return {...f,request};
 }
 it("returns selected-hire permissions without changing the original order or persisted request",async()=>{
  const f=await independentQuestion(),before=structuredClone(f.rows.get(f.bookingId));
  const planned=await invoke(select_rental_request,f.ctx,{thread_id:f.args.thread_id,intent:"new"});
  expect(planned.active_request_stage).toMatchObject({stage:"INQUIRY",can_confirm_booking:false,can_share_pickup_address:false,can_acknowledge_owner_acceptance:false});
  const context=await invoke(get_renter_context,f.ctx,{thread_id:f.args.thread_id,rental_request:planned.rental_request});
  expect(context).toMatchObject({conversation_stage:"INQUIRY",active_request_stage:{can_confirm_booking:false},rental_stage:{can_confirm_booking:true}});
  const primary=await invoke(get_renter_context,f.ctx,{thread_id:f.args.thread_id,rental_request:{kind:"primary"}});
  expect(primary.active_request_stage.can_confirm_booking).toBe(true);
  expect(f.rows.get(f.bookingId)).toEqual(before);expect(f.rows.get(f.convId).active_rental_request).toBeUndefined();
 });
 it("blocks independent inquiry confirmation and acceptance even without a stock quote",async()=>{
  const f=await independentQuestion();
  expect(await recheck(f,"Your booking is confirmed.")).toEqual({ok:false,reason:"booking_state_unverified"});
  expect(await recheck(f,"Your booking is approved.")).toEqual({ok:false,reason:"booking_state_unverified"});
  expect(await recheck(f,"Your current rental is confirmed.")).toMatchObject({ok:true});
  expect(await recheck(f,"I can check availability for the separate rental.")).toMatchObject({ok:true});
 });
 it("withholds pickup details for an independent unconfirmed question without a quote",async()=>{
  const f=await independentQuestion(),account=await f.ctx.db.insert("accounts",{slug:"leo"});
  await f.ctx.db.insert("account_profiles",{account_id:account,pickup_address:"123 Owner Lane"});
  expect(await recheck(f,"Collect the new rental from 123 Owner Lane.")).toEqual({ok:false,reason:"pickup_details_unverified"});
 });
 it("revalidates supplied contents after inventory records change",async()=>{
  const f=await stockDraft();await f.ctx.db.patch(f.itemId,{kind:"camera",compatibility:{included_with_rental:["2 x NP-FZ100 batteries","1 x 128GB SD card"]}});
  expect(await recheck(f,"Sony FX3 includes two NP-FZ100 batteries and a 128GB SD card.")).toMatchObject({ok:true});
  await f.ctx.db.patch(f.itemId,{compatibility:{included_with_rental:["1 x NP-FZ100 battery","1 x 64GB SD card"]}});
  expect(await recheck(f,"Sony FX3 includes two NP-FZ100 batteries and a 128GB SD card.")).toEqual({ok:false,reason:"kit_contents_unverified"});
  expect(await recheck(f,"Sony FX3 includes one NP-FZ100 battery and a 64GB SD card.")).toMatchObject({ok:true});
 });
 it("rebuilds exact listing components rather than borrowing advertising or old mapping names",async()=>{
  const f=await stockDraft();await f.ctx.db.patch(f.itemId,{kind:"camera"});
  const card=await f.ctx.db.insert("items",{name_canonical:"128GB SD card",kind:"storage",status:"active",qty:1});
  await f.ctx.db.insert("hygglo_products",{accountSlug:"leo",productId:123,name:"Sony FX3 Kit",masterItemId:f.itemId});
  await f.ctx.db.insert("online_listings",{account_slug:"leo",product_id:123,name:"Sony FX3 Kit + 1TB SSD",description:"",daily_price:30});
  await f.ctx.db.insert("listing_resolution_override",{account_slug:"leo",product_id:123,components:[{item_id:f.itemId,qty:1},{item_id:card,qty:1}]});
  await f.ctx.db.patch(f.bookingId,{hygglo_items:[{name:"Sony FX3 Kit",qty:1,product_id:123}]});
  f.args.context_key=draftContextKey(f.rows.get(f.bookingId));
  await invoke(setDraft,f.ctx,{thread_id:f.args.thread_id,message_id:f.args.message_id,epoch:2,context_key:f.args.context_key,draft_text:f.text,evidence:f.evidence});
  f.approval=await invoke(getDraftApprovalContext,f.ctx,{thread_id:f.args.thread_id});
  expect(await recheck(f,"Sony FX3 Kit includes a 128GB SD card.")).toMatchObject({ok:true});
  expect(await recheck(f,"Sony FX3 Kit includes a 1TB SSD.")).toEqual({ok:false,reason:"kit_contents_unverified"});
  await f.ctx.db.patch(card,{name_canonical:"64GB SD card"});
  expect(await recheck(f,"Sony FX3 Kit includes a 128GB SD card.")).toEqual({ok:false,reason:"kit_contents_unverified"});
  expect(await recheck(f,"Sony FX3 Kit includes a 64GB SD card.")).toMatchObject({ok:true});
 });
 it("rejects invented supplied storage but permits a verification question",async()=>{
  const f=await stockDraft();
  expect(await recheck(f,"Sony FX3 comes with a 1TB CFexpress Type B card.")).toEqual({ok:false,reason:"kit_contents_unverified"});
  expect(await recheck(f,"Does the Sony FX3 include a 1TB CFexpress Type B card?")).toMatchObject({ok:true});
  expect(await recheck(f,"Unidentified camera comes with a 1TB SD card.")).toEqual({ok:false,reason:"kit_contents_unverified"});
 });
 it("does not borrow another item's contents or marketing-only records",async()=>{
  const f=await stockDraft();await f.ctx.db.patch(f.itemId,{kind:"camera"});
  await f.ctx.db.insert("items",{name_canonical:"BMPCC 6K Full Frame",kind:"camera",status:"active",qty:1,is_marketing_only:true,compatibility:{included_with_rental:["1 x 1TB CFexpress Type B card"]}});
  expect(await recheck(f,"BMPCC 6K Full Frame includes a 1TB CFexpress Type B card.")).toEqual({ok:false,reason:"kit_contents_unverified"});
  expect(await recheck(f,"Sony FX3 includes the BMPCC 6K Full Frame's 1TB CFexpress Type B card.")).toEqual({ok:false,reason:"kit_contents_unverified"});
 });
 it("quotes an independent hire without releasing the current rental, and preserves that purpose at approval",async()=>{
  const f=await stockDraft();await f.ctx.db.patch(f.itemId,{kind:'camera'});
  await f.ctx.db.insert('hygglo_products',{accountSlug:'leo',productId:123,name:'Sony FX3',masterItemId:f.itemId,prices:[]});
  await f.ctx.db.insert('online_listings',{account_slug:'leo',product_id:123,name:'Sony FX3',daily_price:30});
  await f.ctx.db.insert('listing_resolution_override',{account_slug:'leo',product_id:123,components:[{item_id:f.itemId,qty:1}]});
  await f.ctx.db.patch(f.bookingId,{status:'confirmed',hygglo_items:[{name:'Sony FX3',qty:1,product_id:123}],expanded_items:[{item_id:f.itemId,qty:1}]});
  const before=structuredClone(f.rows.get(f.bookingId));
  const input={account_slug:'leo',thread_id:f.args.thread_id,start_date:'2026-10-02',end_date:'2026-10-04',items:[{item_name:'Sony FX3',product_id:123,quantity:1}]};
  expect(await performJointStockCheck(f.ctx as any,{...input,booking_use:'standalone'})).toMatchObject({available:null,reason:'choose_addition_or_exact_replacement'});
  const overlap=await performJointStockCheck(f.ctx as any,{...input,booking_use:'separate'});
  expect(overlap).toMatchObject({available:false,new_inquiry:true,booking_use:'separate'});
  expect(overlap.components[0]).toMatchObject({free_units:0,new_inquiry:true});
  const future=await performJointStockCheck(f.ctx as any,{...input,booking_use:'separate',start_date:'2026-10-22',end_date:'2026-10-24'});
  expect(future).toMatchObject({available:true,new_inquiry:true,quote:{total_gbp:90},components:[{new_inquiry:true}]});
  const individual={account_slug:'leo',thread_id:f.args.thread_id,item_name:'Sony FX3',product_id:123,quantity:1,start_date:input.start_date,end_date:input.end_date};
  expect(await invoke(check_availability,f.ctx,{...individual,booking_use:'separate'})).toMatchObject({available:false,new_inquiry:true,components:[{free_units:0,new_inquiry:true}]});
  expect(await invoke(check_availability,f.ctx,{...individual,booking_use:'separate',start_date:'2026-10-22',end_date:'2026-10-24'})).toMatchObject({available:true,new_inquiry:true,components:[{new_inquiry:true}]});
  expect(await invoke(check_availability,f.ctx,{...individual,booking_use:'current'})).toMatchObject({available:true,booking_use:'current'});
  // Availability-only saved evidence must keep the same reservation exclusion.
  f.args.context_key=draftContextKey(f.rows.get(f.bookingId));
  const text='Sony FX3 is available for 2 to 4 October.';
  await invoke(setDraft,f.ctx,{thread_id:f.args.thread_id,message_id:f.args.message_id,epoch:2,context_key:f.args.context_key,draft_text:text,
   evidence:{...f.evidence,stock:f.evidence.stock.map(r=>({...r,new_inquiry:true}))}});
  f.approval=await invoke(getDraftApprovalContext,f.ctx,{thread_id:f.args.thread_id});
  expect(await recheck(f,text)).toMatchObject({ok:false,reason:'stock_unverified'});
  expect(await recheck(f,'Your new rental is confirmed.')).toMatchObject({ok:false,reason:'booking_state_unverified'});
  expect(await recheck(f,'Your booking is confirmed.')).toMatchObject({ok:false,reason:'booking_state_unverified'});
  expect(await recheck(f,'Your current rental is confirmed.')).toMatchObject({ok:true});
  expect(f.rows.get(f.bookingId)).toEqual(before);
 });
 it("checks camera referents against renter evidence during copied-draft approval",async()=>{
  const f=await stockDraft();
  expect(await recheck(f,"Which Sony body are you using?")).toMatchObject({ok:false,reason:"renter_camera_identity_unverified"});
  expect(await recheck(f,"Which camera body are you using?")).toMatchObject({ok:true});
  const inbound=[...f.rows.values()].find(r=>r.table==="hygglo_messages");
  await f.ctx.db.patch(inbound._id,{sender:"renter",body_text:"I'm shooting with a Sony FX3."});
  expect(await recheck(f,"Which Sony body are you using?")).toMatchObject({ok:true});
  expect(await recheck(f,"Your Canon camera is ready.")).toMatchObject({ok:false,reason:"renter_camera_identity_unverified"});
 });
 it("rejects a competing confirmed booking created after a previously available draft",async()=>{
  const f=await stockDraft();expect(await recheck(f)).toMatchObject({ok:true});
  await f.ctx.db.insert("reservations",{hygglo_order_id:"competing-rental",status:"confirmed",start_date:"2026-10-02",end_date:"2026-10-04",expanded_items:[{item_id:f.itemId,qty:1}]});
  expect(await recheck(f)).toMatchObject({ok:false,reason:"stock_unverified"});
  expect(await recheck(f,"I can offer the Sony FX3 for 2 to 4 October.")).toMatchObject({ok:false,reason:"stock_unverified"});
  expect(await recheck(f,"Thanks for checking. I'll review the options and get back to you.")).toMatchObject({ok:true});
 });
 it("rechecks selected price-only baskets even without an availability assertion or technical requirements",async()=>{
  const f=await inquiryStockDraft();const text="For 3 days: 1 × Sony FX3: £90. Total: £90.";
  await f.ctx.db.insert("hygglo_products",{accountSlug:"leo",productId:123,name:"Sony FX3",masterItemId:f.itemId,prices:[]});
  await f.ctx.db.insert("online_listings",{account_slug:"leo",product_id:123,name:"Sony FX3",daily_price:30});
  await f.ctx.db.insert("listing_resolution_override",{account_slug:"leo",product_id:123,components:[{item_id:f.itemId,qty:1}]});
  const evidence={model_id:"native-test",stage:"INQUIRY",stock:[],stock_quotes:[{quote_key:"selected-native",start_date:"2026-10-02",end_date:"2026-10-04",listing_quote:{total_gbp:90,lines:[{product_id:123,name:"Sony FX3",quantity:1,total_gbp:90}]},items:[{item_id:f.itemId,name:"Sony FX3",quantity:1}]}]};
  await invoke(setDraft,f.ctx,{thread_id:f.args.thread_id,message_id:f.args.message_id,epoch:2,context_key:f.args.context_key,draft_text:text,evidence});
  f.approval=await invoke(getDraftApprovalContext,f.ctx,{thread_id:f.args.thread_id});
  expect(await recheck(f,text)).toMatchObject({ok:true});
  const blocker=await f.ctx.db.insert("reservations",{hygglo_order_id:"price-only-blocker",status:"confirmed",start_date:"2026-10-02",end_date:"2026-10-04",expanded_items:[{item_id:f.itemId,qty:1}]});
  expect(await recheck(f,text)).toMatchObject({ok:false,reason:"stock_unverified"});
  await f.ctx.db.patch(blocker,{status:"cancelled"});
  expect(await recheck(f,text)).toMatchObject({ok:true});
  await f.ctx.db.patch(f.itemId,{is_marketing_only:true});
  expect(await recheck(f,text)).toMatchObject({ok:false});
  await f.ctx.db.patch(f.itemId,{is_marketing_only:false,name_canonical:"Sony FX30"});
  expect(await recheck(f,text)).toMatchObject({ok:false});
 });
 it("rejects changed listing prices and tiers even when current stock still passes",async()=>{
  const f=await inquiryStockDraft(),text="For 3 days: 1 × Sony FX3: £90. Total: £90.";
  const product=await f.ctx.db.insert("hygglo_products",{accountSlug:"leo",productId:123,name:"Sony FX3",masterItemId:f.itemId,prices:[]});
  const listing=await f.ctx.db.insert("online_listings",{account_slug:"leo",product_id:123,name:"Sony FX3",daily_price:30});
  const mapping=await f.ctx.db.insert("listing_resolution_override",{account_slug:"leo",product_id:123,components:[{item_id:f.itemId,qty:1}]});
  const evidence={model_id:"native-test",stage:"INQUIRY",stock:[],stock_quotes:[{quote_key:"selected-native",start_date:"2026-10-02",end_date:"2026-10-04",
    listing_quote:{total_gbp:90,lines:[{product_id:123,name:"Sony FX3",quantity:1,total_gbp:90}]},items:[{item_id:f.itemId,name:"Sony FX3",quantity:1}]}]};
  await invoke(setDraft,f.ctx,{thread_id:f.args.thread_id,message_id:f.args.message_id,epoch:2,context_key:f.args.context_key,draft_text:text,evidence});
  f.approval=await invoke(getDraftApprovalContext,f.ctx,{thread_id:f.args.thread_id});
  expect(await recheck(f,text)).toMatchObject({ok:true});
  expect(await recheck(f,text.replaceAll("£90","£60"))).toMatchObject({ok:false,reason:"price_unverified"});
  expect(await recheck(f,`Thanks for checking. ${text} Let me know when you're ready.`)).toMatchObject({ok:true});
  expect(await recheck(f,text.replace("1 ×","2 ×"))).toMatchObject({ok:false,reason:"price_unverified"});
  expect(await recheck(f,text+" Delivery is £10.")).toMatchObject({ok:false,reason:"price_unverified"});
  // Recheck a complete Native offer after an inquiry already has gear. The
  // original message's addition semantics must not add that base basket again.
  const order={thread_id:f.args.thread_id,account_slug:"leo",items:[{name:"Sony FX3",product_id:123,qty:1,daily_price_gbp:30,pricing_basis:"listing"}],start_date:"2026-10-02",end_date:"2026-10-04",changes:[],updated_at:1};
  await f.ctx.db.insert("renter_bot_lab_orders",order);
  f.args.context_key=draftContextKey(null,undefined,order as any);
  await invoke(setDraft,f.ctx,{thread_id:f.args.thread_id,message_id:f.args.message_id,epoch:2,context_key:f.args.context_key,draft_text:text,evidence});
  f.approval=await invoke(getDraftApprovalContext,f.ctx,{thread_id:f.args.thread_id});
  const inbound=[...f.rows.values()].find(r=>r.table==="hygglo_messages");
  await f.ctx.db.patch(inbound._id,{sender:"renter",body_text:"Please add a lens to my basket."});
  expect(await recheck(f,text)).toMatchObject({ok:true});
  await f.ctx.db.patch(listing,{daily_price:40});
  expect(await recheck(f,text)).toMatchObject({ok:false,reason:"price_unverified"});
  await f.ctx.db.patch(listing,{daily_price:30});
  await f.ctx.db.patch(product,{prices:[{days:3,pricePerDay:25}]});
  expect(await recheck(f,text)).toMatchObject({ok:false,reason:"price_unverified"});
  await f.ctx.db.patch(product,{prices:[]});
  expect(await recheck(f,text)).toMatchObject({ok:true});
  await f.ctx.db.patch(listing,{daily_price:undefined});
  expect(await recheck(f,text)).toMatchObject({ok:false,reason:"price_unverified"});
  await f.ctx.db.patch(listing,{daily_price:30});
  const different=await f.ctx.db.insert("items",{name_canonical:"Sony FX30",qty:1,status:"active",is_marketing_only:false});
  await f.ctx.db.patch(mapping,{components:[{item_id:different,qty:1}]});
  expect(await recheck(f,text)).toMatchObject({ok:false,reason:"stock_unverified"});
 });
 it("checks each quoted line when changed rates leave the combined total unchanged",async()=>{
  const f=await inquiryStockDraft();await f.ctx.db.patch(f.itemId,{qty:2});
  const listings=[];
  for(const [productId,rate] of [[123,20],[124,10]]){
   await f.ctx.db.insert("hygglo_products",{accountSlug:"leo",productId,name:"Sony FX3",masterItemId:f.itemId,prices:[]});
   listings.push(await f.ctx.db.insert("online_listings",{account_slug:"leo",product_id:productId,name:"Sony FX3",daily_price:rate}));
   await f.ctx.db.insert("listing_resolution_override",{account_slug:"leo",product_id:productId,components:[{item_id:f.itemId,qty:1}]});
  }
  const text="For 3 days (2 October 2026 to 4 October 2026):\n- 1 × Sony FX3: £60\n- 1 × Sony FX3: £30\nTotal: £90";
  await invoke(setDraft,f.ctx,{thread_id:f.args.thread_id,message_id:f.args.message_id,epoch:2,context_key:f.args.context_key,draft_text:text,
   evidence:{model_id:"native-test",stage:"INQUIRY",stock:[],stock_quotes:[{quote_key:"selected-native",start_date:"2026-10-02",end_date:"2026-10-04",
     listing_quote:{total_gbp:90,lines:[{product_id:123,name:"Sony FX3",quantity:1,total_gbp:60},{product_id:124,name:"Sony FX3",quantity:1,total_gbp:30}]},items:[{item_id:f.itemId,name:"Sony FX3",quantity:2}]}]}});
  f.approval=await invoke(getDraftApprovalContext,f.ctx,{thread_id:f.args.thread_id});
  expect(await recheck(f,text)).toMatchObject({ok:true});
  await f.ctx.db.patch(listings[0],{daily_price:22});await f.ctx.db.patch(listings[1],{daily_price:8});
  expect(await recheck(f,text)).toMatchObject({ok:false,reason:"price_unverified"});
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
 it("rechecks saved technical requirements even when the copied reply makes only an implicit recommendation",async()=>{
  const f=await stockDraft();await f.ctx.db.patch(f.itemId,{kind:"camera",lens_mount:"E"});
  const specId=await f.ctx.db.insert("item_specs",{item_id:f.itemId,item_name_canonical:"Sony FX3",description:"Reviewed camera",source:"owner-verified",verified_model:"Sony FX3",verified_at:1,
   camera_capabilities:{role:"interchangeable_lens",sensor_format:"full_frame",native_mount:"E",internal_4k:true,verified_model:"Sony FX3",verified_at:1}});
  const text="Here is an option for those dates.";
  const evidence={...f.evidence,recommendation_quotes:[{quote_key:"native-inquiry-test",requirements:[{kind:"camera",requirements:{internal_4k:true,sensor_format:"full_frame"},quantity:1}],items:[{item_id:f.itemId,name:"Sony FX3",quantity:1}]}]};
  await invoke(setDraft,f.ctx,{thread_id:f.args.thread_id,message_id:f.args.message_id,epoch:2,context_key:f.args.context_key,draft_text:text,evidence});
  f.approval=await invoke(getDraftApprovalContext,f.ctx,{thread_id:f.args.thread_id});
  expect(await recheck(f,text)).toMatchObject({ok:true});
  await f.ctx.db.patch(specId,{camera_capabilities:{role:"interchangeable_lens",sensor_format:"full_frame",native_mount:"E",internal_4k:false,verified_model:"Sony FX3",verified_at:1}});
  expect(await recheck(f,text)).toMatchObject({ok:false,reason:"technical_requirements_unverified"});
  await f.ctx.db.patch(specId,{camera_capabilities:{role:"interchangeable_lens",sensor_format:"full_frame",native_mount:"E",internal_4k:true,verified_model:"Sony FX3",verified_at:1},verified_at:2});
  expect(await recheck(f,text)).toMatchObject({ok:false,reason:"technical_requirements_unverified"});
  await f.ctx.db.patch(specId,{verified_at:1});
  expect(await recheck(f,text)).toMatchObject({ok:true});
  await f.ctx.db.patch(f.itemId,{name_canonical:"Sony FX30"});
  expect(await recheck(f,text)).toMatchObject({ok:false,reason:"technical_requirements_unverified"});
 });
 it("rechecks camera/lens setup identity even when the selected quote had no search criteria",async()=>{
  const f=await stockDraft();await f.ctx.db.patch(f.itemId,{kind:"camera",lens_mount:"E"});
  await f.ctx.db.insert("item_specs",{item_id:f.itemId,item_name_canonical:"Sony FX3",description:"Reviewed body",source:"owner-verified",verified_model:"Sony FX3",verified_at:1,
   camera_capabilities:{role:"interchangeable_lens",sensor_format:"full_frame",native_mount:"E",internal_4k:true,verified_model:"Sony FX3",verified_at:1}});
  const lensId=await f.ctx.db.insert("items",{name_canonical:"Lens",kind:"lens",lens_mount:"E",qty:1,status:"active",is_marketing_only:false});
  await f.ctx.db.insert("item_specs",{item_id:lensId,item_name_canonical:"Lens",description:"Reviewed lens",source:"manufacturer-verified",source_url:"https://example.test/lens",verified_model:"Lens",verified_at:1,
   lens_capabilities:{focus_mode:"autofocus",coverage:"full_frame",verified_model:"Lens",verified_at:1,source_url:"https://example.test/lens"}});
  const text="Here is the setup for those dates.";
  await invoke(setDraft,f.ctx,{thread_id:f.args.thread_id,message_id:f.args.message_id,epoch:2,context_key:f.args.context_key,draft_text:text,
   evidence:{...f.evidence,recommendation_quotes:[{quote_key:"selected-native",requirements:[],items:[{item_id:f.itemId,name:"Sony FX3",quantity:1},{item_id:lensId,name:"Lens",quantity:1}]}]}});
  f.approval=await invoke(getDraftApprovalContext,f.ctx,{thread_id:f.args.thread_id});
  expect(await recheck(f,text)).toMatchObject({ok:true});
  await f.ctx.db.patch(lensId,{lens_mount:"PL"});
  expect(await recheck(f,text)).toMatchObject({ok:false,reason:"technical_requirements_unverified"});
 });
 it("checks copied stock before even dry-run success and fails closed when the check errors",async()=>{
  const f=await stockDraft();
  for(const result of [{ok:false,reason:"stock_unverified"},{ok:false,reason:"price_unverified"},{ok:false,reason:"technical_requirements_unverified"},{ok:true}]) {
   const ctx={runQuery:vi.fn().mockResolvedValueOnce(f.approval).mockResolvedValueOnce(result)};
   const sent=await invoke(sendRenterReply,ctx,{thread_id:f.args.thread_id,account_slug:"leo",text:f.text,draft_approval:f.approval.draft_approval,dryRun:true});
   expect(sent).toMatchObject(result.ok?{status:"sent",reason:"DRY_RUN"}:{status:"failed",reason:result.reason});
   if(result.reason==="price_unverified")expect(sent.error).toContain("price");
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
 const check={kind:"lens_recommendation",requirements:{focus_mode:"autofocus"},lens_mount:"E",start_date:"2026-10-20",end_date:"2026-10-21",quantity:1};
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

describe("kit owner checks persist through the real review mutation",()=>{
 async function kit() {
  const f=await setup();await f.ctx.db.patch(f.convId,{account_slug:"leo"});
  const camera=await f.ctx.db.insert("items",{name_canonical:"Sony FX3",kind:"camera",qty:4,status:"active"});
  const lens=await f.ctx.db.insert("items",{name_canonical:"Sony GM 24-70mm f2.8",kind:"lens",qty:4,status:"active"});
  await f.ctx.db.insert("hygglo_products",{accountSlug:"leo",productId:10,name:"FX3 lens kit",masterItemId:camera});
  await f.ctx.db.insert("online_listings",{account_slug:"leo",product_id:10,description:"Included in this kit: • 1x Sony FX3 • 1x Sony GM 24-70mm f2.8"});
  const override=await f.ctx.db.insert("listing_resolution_override",{account_slug:"leo",product_id:10,components:[{item_id:camera,qty:1}]});
  await f.ctx.db.patch(f.bookingId,{account_slug:"leo",hygglo_items:[{name:"FX3 lens kit",product_id:10,qty:1}]});
  for(const m of f.rows.values())if(m.table==="hygglo_messages")await f.ctx.db.patch(m._id,{sender:"renter",body_text:"Does the kit come with the lens?"});
  f.args.context_key=draftContextKey(f.rows.get(f.bookingId));
  const check={kind:"listing_mapping" as const,source_call_id:"native-listing-context",product_id:10,start_date:"2026-10-02",end_date:"2026-10-04",quantity:1};
  return {...f,camera,lens,override,check};
 }
 const tasks=(f:Awaited<ReturnType<typeof kit>>)=>[...f.rows.values()].filter(r=>r.table==="renter_bot_owner_checks");
 it("turns an unqualified current basket into a durable lens review without denying stock",async()=>{
  const f=await kit();
  await f.ctx.db.patch(f.camera,{lens_mount:"E"});await f.ctx.db.patch(f.lens,{lens_mount:"E"});
  await f.ctx.db.patch(f.override,{components:[{item_id:f.camera,qty:1},{item_id:f.lens,qty:1}]});
  await f.ctx.db.insert("item_specs",{item_name_canonical:"Sony FX3",item_id:f.camera,source:"manufacturer-verified",source_url:"https://manufacturer.example/fx3",verified_model:"Sony FX3",verified_at:1,
   camera_capabilities:{role:"interchangeable_lens",native_mount:"E",sensor_format:"full_frame",verified_model:"Sony FX3",source_url:"https://manufacturer.example/fx3",verified_at:1}});
  const result=await performJointStockCheck(f.ctx as any,{account_slug:"leo",thread_id:f.args.thread_id,start_date:"2026-10-20",end_date:"2026-10-21",booking_use:"standalone",items:[{item_name:"FX3 lens kit",product_id:10,quantity:1}]});
  expect(result.available).toBe(true);if(!("technical_qualification" in result))throw new Error("Missing basket qualification");expect(result.technical_qualification).toMatchObject({verified:false,setup:{status:"unknown",unknown:["lens_sensor_coverage"]}});
  const checks=nativeOwnerChecks([{tool:"check_basket_availability",call_id:"native-basket",result}]);
  expect(checks).toEqual([{kind:"lens_recommendation",source_call_id:"native-basket",requirements:{coverage:"full_frame"},candidate_item_ids:[f.lens],lens_mount:null,start_date:"2026-10-20",end_date:"2026-10-21",quantity:1}]);
  await invoke(setDraftReview,f.ctx,{...f.args,owner_checks:checks});await invoke(setDraftReview,f.ctx,{...f.args,owner_checks:checks});
  expect(tasks(f)).toHaveLength(1);expect(tasks(f)[0]).toMatchObject({status:"pending",candidate_names:["Sony GM 24-70mm f2.8"],check:checks[0]});
  await f.ctx.db.insert("item_specs",{item_name_canonical:"Sony GM 24-70mm f2.8",item_id:f.lens,source:"manufacturer-verified",verified_model:"Sony GM 24-70mm f2.8",source_url:"https://manufacturer.example/lens",verified_at:1,
   lens_capabilities:{coverage:"full_frame",verified_model:"Sony GM 24-70mm f2.8",source_url:"https://manufacturer.example/lens",verified_at:1}});
  const qualified=await performJointStockCheck(f.ctx as any,{account_slug:"leo",thread_id:f.args.thread_id,start_date:"2026-10-20",end_date:"2026-10-21",booking_use:"standalone",items:[{item_name:"FX3 lens kit",product_id:10,quantity:1}]});
  if(!("technical_qualification" in qualified))throw new Error("Missing basket qualification");expect(qualified.technical_qualification).toMatchObject({verified:true,setup:{status:"match"}});expect(qualified.owner_checks).toEqual([]);
 });
 it("uses the same supplied-stock and media evidence for listing, pricing and recommendations",async()=>{
  const f=await kit();
  const card=await f.ctx.db.insert("items",{name_canonical:"256GB card",kind:"accessory",qty:4,status:"active",track_independent_stock:true,unit_kind:"unit"});
  await f.ctx.db.patch(f.camera,{supplied_stock:[{item_id:card,qty:1,source:"owner-verified"}],compatibility:{included_with_rental:["CFexpress Type A card"]}});
  const listing=[...f.rows.values()].find(r=>r.table==="online_listings"&&r.product_id===10);
  await f.ctx.db.patch(listing._id,{name:"Sony FX3",description:"Included in this kit: • 1x Sony FX3",daily_price:40});
  await f.ctx.db.insert("item_specs",{item_name_canonical:"Sony FX3",item_id:f.camera,source:"manufacturer-verified",source_url:"https://manufacturer.example/fx3",verified_model:"Sony FX3",verified_at:1,
   camera_capabilities:{role:"interchangeable_lens",sensor_format:"full_frame",native_mount:"E",internal_4k:true,verified_model:"Sony FX3",source_url:"https://manufacturer.example/fx3",verified_at:1}});
  const context=await invoke(get_listing_context,f.ctx,{thread_id:f.args.thread_id});
  const price=await invoke(lookup_pricing,f.ctx,{account_slug:"leo",item_name:"Sony FX3",days:1});
  const alternatives=await invoke(find_owned_alternatives,f.ctx,{account_slug:"leo",kind:"camera"});
  expect(price).toMatchObject({found:true,storage_contents_verification_required:true});
  const alt=alternatives.alternatives.find((a:any)=>a.product_id===10);expect(alt).toBeDefined();
  expect(alt.kit_contents).toEqual(context.items[0].kit_contents);
  expect(alt.kit_contents).toContain("1 × 256GB card");
  expect(alt).toMatchObject({mapping_complete:true,storage_contents_verification_required:true,unreconciled_kit_contents:["CFexpress Type A card"]});
  expect(alternatives.owner_check).toMatchObject({kind:"kit_recommendation",candidate_product_ids:[10]});
  // A reviewed physical identity removes ambiguity on every read path.
  await f.ctx.db.patch(card,{name_canonical:"256GB CFexpress Type A card"});
  const reviewed=await invoke(get_listing_context,f.ctx,{thread_id:f.args.thread_id});
  expect(reviewed.items[0].storage_contents_verification_required).toBe(false);
  expect(await invoke(lookup_pricing,f.ctx,{account_slug:"leo",item_name:"Sony FX3",days:1})).toMatchObject({found:true,storage_contents_verification_required:false});
  const refreshed=await invoke(find_owned_alternatives,f.ctx,{account_slug:"leo",kind:"camera"});
  expect(refreshed.alternatives[0].kit_contents).toEqual(reviewed.items[0].kit_contents);
  expect(refreshed.alternatives[0].storage_contents_verification_required).toBe(false);
 });
 it("persists one grouped recommended-kit review without treating an alternative as the current rental",async()=>{
  const f=await kit();
  await f.ctx.db.patch(f.camera,{compatibility:{included_with_rental:["1x 1TB SSD"]}});
  await f.ctx.db.insert("online_listings",{account_slug:"leo",product_id:20,name:"Sony FX3 with 256GB card",description:"Included in this kit: • 1x Sony FX3",daily_price:40});
  await f.ctx.db.insert("listing_resolution_override",{account_slug:"leo",product_id:20,components:[{item_id:f.camera,qty:1}]});
  await f.ctx.db.insert("item_specs",{item_name_canonical:"Sony FX3",item_id:f.camera,source:"manufacturer-verified",source_url:"https://manufacturer.example/fx3",verified_model:"Sony FX3",verified_at:1,
   camera_capabilities:{role:"interchangeable_lens",sensor_format:"full_frame",native_mount:"E",internal_4k:true,verified_model:"Sony FX3",source_url:"https://manufacturer.example/fx3",verified_at:1}});
  const result=await invoke(find_owned_alternatives,f.ctx,{account_slug:"leo",kind:"camera"});
  expect(result.owner_check).toMatchObject({kind:"kit_recommendation",candidate_product_ids:[20],start_date:null,end_date:null});
  const checks=nativeOwnerChecks([{tool:"find_owned_alternatives",call_id:"native-kit-options",result}]);expect(checks).toHaveLength(1);
  await invoke(setDraftReview,f.ctx,{...f.args,owner_checks:checks});await invoke(setDraftReview,f.ctx,{...f.args,owner_checks:checks});
  expect(tasks(f)).toHaveLength(1);expect(tasks(f)[0].check.kind).toBe("kit_recommendation");expect(tasks(f)[0].candidate_names).toEqual(["Sony FX3"]);
  // The current-order mapping guard must still reject a foreign basket line.
  await invoke(setDraftReview,f.ctx,{...f.args,owner_checks:[{...f.check,product_id:20}]});expect(tasks(f)).toHaveLength(1);
  expect(await ownerChecksForBot(f.ctx as any,f.args.thread_id,f.args.context_key)).toContainEqual(expect.objectContaining({kind:"kit_recommendation",candidate_product_ids:[20],specification_result_verified:false,customer_input_required:false}));
 });
 it("keeps inventory reviews pending while removing them from renter context, and reopens them when required",async()=>{
  const f=await kit();await f.ctx.db.patch(f.camera,{compatibility:{included_with_rental:["1x 1TB SSD"]}});
  await f.ctx.db.insert("online_listings",{account_slug:"leo",product_id:20,name:"Sony FX3 with 256GB card",description:"Included in this kit: • 1x Sony FX3",daily_price:40});
  await f.ctx.db.insert("listing_resolution_override",{account_slug:"leo",product_id:20,components:[{item_id:f.camera,qty:1}]});
  const check={kind:"kit_recommendation" as const,source_call_id:"native-search",candidate_product_ids:[20],start_date:null,end_date:null,quantity:1,purpose:"inventory" as const};
  await invoke(setDraftReview,f.ctx,{...f.args,owner_checks:[check]});
  expect(tasks(f)).toHaveLength(1);expect(tasks(f)[0]).toMatchObject({status:"pending",check:{purpose:"inventory"}});
  expect(await ownerChecksForBot(f.ctx as any,f.args.thread_id,f.args.context_key)).toEqual([]);
  (f.ctx as any).auth={getUserIdentity:async()=>({subject:"test-owner"})};
  await invoke(handleOwnerCheck,f.ctx,{id:tasks(f)[0]._id,note:"Reviewed the inventory issue separately.",expected_request_message_id:f.args.message_id});
  await invoke(setDraftReview,f.ctx,{...f.args,owner_checks:[{...check,purpose:"request"}]});
  expect(tasks(f)).toHaveLength(1);expect(tasks(f)[0]).toMatchObject({status:"pending",check:{purpose:"request"}});
  expect(await ownerChecksForBot(f.ctx as any,f.args.thread_id,f.args.context_key)).toContainEqual(expect.objectContaining({kind:"kit_recommendation",specification_result_verified:false}));
 });
 it("rechecks recommended kit conflicts and rejects marketing or foreign-account candidates",async()=>{
  for(const invalid of ["resolved","marketing","foreign"]){
   const f=await kit();await f.ctx.db.patch(f.camera,{compatibility:{included_with_rental:["1x 1TB SSD"]},...(invalid==="marketing"?{is_marketing_only:true}:{})});
   await f.ctx.db.insert("online_listings",{account_slug:invalid==="foreign"?"other":"leo",product_id:20,name:invalid==="resolved"?"Sony FX3 with 1TB SSD":"Sony FX3 with 256GB card",description:"Included in this kit: • 1x Sony FX3"});
   await f.ctx.db.insert("listing_resolution_override",{account_slug:invalid==="foreign"?"other":"leo",product_id:20,components:[{item_id:f.camera,qty:1}]});
   const check={kind:"kit_recommendation" as const,source_call_id:"native-kit-options",candidate_product_ids:[20],start_date:null,end_date:null,quantity:1};
   await invoke(setDraftReview,f.ctx,{...f.args,owner_checks:[check]});expect(tasks(f)).toEqual([]);
  }
 });
 it("keeps a Native owner task for conflicting supplied storage after physical mapping is complete",async()=>{
  const f=await kit();
  await f.ctx.db.patch(f.override,{components:[{item_id:f.camera,qty:1}]});
  const listing=[...f.rows.values()].find(r=>r.table==="online_listings"&&r.product_id===10);
  await f.ctx.db.patch(listing._id,{name:"Sony FX3 with 256GB card",description:"Included in this kit: • 1x Sony FX3"});
  await f.ctx.db.patch(f.camera,{compatibility:{included_with_rental:["1x 1TB SSD"]}});
  const context=await invoke(get_listing_context,f.ctx,{thread_id:f.args.thread_id});
  expect(context.items[0].storage_contents_verification_required).toBe(true);expect(context.owner_checks).toHaveLength(1);
  const checks=nativeOwnerChecks([{tool:"get_listing_context",call_id:"native-storage",result:context}]);
  expect(await invoke(setDraftReview,f.ctx,{...f.args,owner_checks:checks})).toMatchObject({ok:true});
  expect(tasks(f)).toHaveLength(1);expect(tasks(f)[0].status).toBe("pending");
  await invoke(setDraftReview,f.ctx,{...f.args,owner_checks:checks});expect(tasks(f)).toHaveLength(1);
  expect(await ownerChecksForBot(f.ctx as any,f.args.thread_id,f.args.context_key)).toContainEqual(expect.objectContaining({kind:"listing_mapping",customer_input_required:false,specification_result_verified:false}));
  const resolved=await kit();const ownListing=[...resolved.rows.values()].find(r=>r.table==="online_listings"&&r.product_id===10);
  await resolved.ctx.db.patch(resolved.override,{components:[{item_id:resolved.camera,qty:1}]});
  await resolved.ctx.db.patch(ownListing._id,{name:"Sony FX3 with 256GB card",description:"Included in this kit: • 1x Sony FX3"});
  await resolved.ctx.db.patch(resolved.camera,{compatibility:{included_with_rental:["1x 256GB card"]}});
  await invoke(setDraftReview,resolved.ctx,{...resolved.args,owner_checks:[resolved.check]});expect(tasks(resolved)).toEqual([]);
 });

 it("harvests actual listing receipts, ignores prose/other tools, and saves durable work",async()=>{
  const f=await kit();const {source_call_id,...check}=f.check;
  const checks=nativeOwnerChecks([{tool:"get_listing_context",call_id:source_call_id,result:{owner_checks:[check]}},{tool:"search",call_id:"untrusted",result:{owner_checks:[check]}}]);
  expect(checks).toEqual([f.check]);
  expect(await invoke(setDraftReview,f.ctx,{...f.args,owner_checks:checks})).toMatchObject({ok:true});
  expect(tasks(f)).toHaveLength(1);expect(tasks(f)[0]).toMatchObject({status:"pending",candidate_names:["FX3 lens kit"],source_question:"Does the kit come with the lens?",check:f.check});
  const context=await ownerChecksForBot(f.ctx as any,f.args.thread_id,f.args.context_key);
  expect(context[0]).toMatchObject({kind:"listing_mapping",product_id:10,requirements:null,customer_input_required:false,specification_result_verified:false});
 });
 it("reuses the unresolved task on retries and a follow-up message with the same basket",async()=>{
  const f=await kit();const save=()=>invoke(setDraftReview,f.ctx,{...f.args,owner_checks:[f.check]});
  await save();await save();expect(tasks(f)).toHaveLength(1);
  await f.ctx.db.insert("hygglo_messages",{thread_id:f.args.thread_id,message_id:"renter-2",sender:"renter",body_text:"Any update?",fetched_at:f.now+1,hygglo_sent_at:f.now+1});
  f.args.message_id="renter-2";await save();expect(tasks(f)).toHaveLength(1);expect(tasks(f)[0].source_message_id).toBe("renter-1");
 });
 it("keeps the task after saving a helpful reply instead of a blocked review",async()=>{
  const f=await kit();
  const saved=await invoke(setDraft,f.ctx,{thread_id:f.args.thread_id,message_id:f.args.message_id,epoch:f.args.epoch,context_key:f.args.context_key,
   draft_text:"I’ll check the lens included in this kit and get back to you.",owner_checks:[f.check]});
  expect(saved).toMatchObject({ok:true});expect(tasks(f)).toHaveLength(1);expect(tasks(f)[0].status).toBe("pending");
 });
 it("rechecks current mapping rather than trusting a formerly incomplete receipt",async()=>{
  const f=await kit();await f.ctx.db.patch(f.override,{components:[{item_id:f.camera,qty:1},{item_id:f.lens,qty:1}]});
  expect(await invoke(setDraftReview,f.ctx,{...f.args,owner_checks:[f.check]})).toMatchObject({ok:true});expect(tasks(f)).toEqual([]);
 });
 it("does not turn a known marketing denial into an owner suitability question",async()=>{
  const f=await kit();await f.ctx.db.patch(f.lens,{is_marketing_only:true});
  await invoke(setDraftReview,f.ctx,{...f.args,owner_checks:[f.check]});expect(tasks(f)).toEqual([]);
 });
 it("rejects foreign listing, changed quantity and changed dates from task input",async()=>{
  const f=await kit();for(const change of [{product_id:11},{quantity:2},{start_date:"2026-10-03"}])
   await invoke(setDraftReview,f.ctx,{...f.args,owner_checks:[{...f.check,...change}]});
  expect(tasks(f)).toEqual([]);
 });
});


describe("camera owner checks use Native facts and preserve human workflow",()=>{
 async function cameraReview() {
  const f=await setup();await f.ctx.db.patch(f.convId,{account_slug:"leo"});
  const body=await f.ctx.db.insert("items",{name_canonical:"Sony FX3",kind:"camera",qty:2,status:"active",is_marketing_only:false});
  const marketing=await f.ctx.db.insert("items",{name_canonical:"Canon R5",kind:"camera",qty:2,status:"active",is_marketing_only:true});
  const wrongKind=await f.ctx.db.insert("items",{name_canonical:"Unknown lens",kind:"lens",qty:2,status:"active",is_marketing_only:false});
  const spec={item_name_canonical:"Sony FX3",description:"Manufacturer-reviewed",source:"manufacturer-verified",source_url:"https://manufacturer.example/fx3",verified_model:"Sony FX3",verified_at:1,
   camera_capabilities:{role:"interchangeable_lens",sensor_format:"full_frame",native_mount:"E",internal_4k:true,built_in_nd:false,verified_model:"Sony FX3",source_url:"https://manufacturer.example/fx3",verified_at:1,
    recording_modes:[{resolution:"uhd_4k",nominal_fps:[60],capture_format:"full_frame",full_width:true,internal:true,conditions:[],verified_model:"Sony FX3",source_url:"https://manufacturer.example/fx3",verified_at:1}]}};
  const specId=await f.ctx.db.insert("item_specs",{...spec,item_id:body});
  for(const m of f.rows.values())if(m.table==="hygglo_messages")await f.ctx.db.patch(m._id,{sender:"renter",body_text:"I need a full-frame camera with uncropped DCI 4K60."});
  const check={kind:"camera_recommendation" as const,source_call_id:"native-camera-search",requirements:{role:"interchangeable_lens" as const,sensor_format:"full_frame" as const,recording:{resolution:"dci_4k" as const,min_fps:60,capture_format:"full_frame" as const,full_width:true,internal:true}},lens_mount:"E",candidate_item_ids:[body,marketing,wrongKind] as Id<"items">[],start_date:"2026-10-20",end_date:"2026-10-21",quantity:1};
  return {...f,body,marketing,wrongKind,spec,specId,check};
 }
 const tasks=(f:Awaited<ReturnType<typeof cameraReview>>)=>[...f.rows.values()].filter(r=>r.table==="renter_bot_owner_checks");
 it("refreshes saved task evidence after the exact reviewed mode is corrected",async()=>{
  const f=await cameraReview();await invoke(setDraftReview,f.ctx,{...f.args,owner_checks:[f.check]});
  expect((await ownerChecksForBot(f.ctx as any,f.args.thread_id,f.args.context_key))[0]).toMatchObject({specification_result_verified:false,current_specification_reviews:[{status:"unknown",unknown:["recording"]}]});
  const capabilities=f.spec.camera_capabilities;
  await f.ctx.db.patch(f.specId,{verified_at:2,camera_capabilities:{...capabilities,verified_at:2,recording_modes:[{...capabilities.recording_modes[0],resolution:"dci_4k",verified_at:2}]}});
  const current=(await ownerChecksForBot(f.ctx as any,f.args.thread_id,f.args.context_key))[0];
  expect(current).toMatchObject({status:"pending",specification_result_verified:true,current_specification_reviews:[{name:"Sony FX3",status:"match",unknown:[]}]});
  expect(current.specification_guidance).toContain("recheck dated stock, price and kit contents");
  expect(tasks(f)[0].status).toBe("pending");
 });
 it("distinguishes reviewed incompatibility, missing properties and task handling",async()=>{
  const f=await cameraReview();await invoke(setDraftReview,f.ctx,{...f.args,owner_checks:[f.check]});
  (f.ctx as any).auth={getUserIdentity:async()=>({subject:"owner"})};
  await invoke(handleOwnerCheck,f.ctx,{id:tasks(f)[0]._id,expected_request_message_id:f.args.message_id,note:"Private note says DCI 4K is fine"});
  const handled=(await ownerChecksForBot(f.ctx as any,f.args.thread_id,f.args.context_key))[0];
  expect(handled).toMatchObject({status:"handled_by_owner",specification_result_verified:false,current_specification_reviews:[{status:"unknown"}]});
  expect(JSON.stringify(handled)).not.toContain("Private note");
  await f.ctx.db.patch(tasks(f)[0]._id,{check:{...f.check,requirements:{role:"action"}}});
  expect((await ownerChecksForBot(f.ctx as any,f.args.thread_id,f.args.context_key))[0]).toMatchObject({specification_result_verified:true,current_specification_reviews:[{status:"mismatch",mismatched:["role"]}]});
 });
 it("rejects duplicate/stale reviews and no longer eligible candidates",async()=>{
  const f=await cameraReview();await invoke(setDraftReview,f.ctx,{...f.args,owner_checks:[f.check]});
  await f.ctx.db.insert("item_specs",{...f.spec,item_id:f.body});
  expect((await ownerChecksForBot(f.ctx as any,f.args.thread_id,f.args.context_key))[0]).toMatchObject({specification_result_verified:false,current_specification_reviews:[{status:"unknown"}]});
  await f.ctx.db.patch(f.body,{is_marketing_only:true});
  expect((await ownerChecksForBot(f.ctx as any,f.args.thread_id,f.args.context_key))[0]).toMatchObject({specification_result_verified:false,current_specification_reviews:[]});
 });
 it("reads each candidate once across repeated saved tasks",async()=>{
  const f=await cameraReview();await invoke(setDraftReview,f.ctx,{...f.args,owner_checks:[f.check]});
  for(let i=0;i<4;i++)await f.ctx.db.insert("renter_bot_owner_checks",{...tasks(f)[0],status:"handled_by_owner"});
  const read=vi.spyOn(f.ctx.db,"get");
  const checks=await ownerChecksForBot(f.ctx as any,f.args.thread_id,f.args.context_key);
  expect(checks).toHaveLength(5);expect(read.mock.calls.filter(([id])=>id===f.body)).toHaveLength(1);
 });
 it("saves actual camera receipts, filters marketing/wrong kinds and retains the pending task after a reply",async()=>{
  const f=await cameraReview(),{source_call_id,...native}=f.check;
  const checks=nativeOwnerChecks([{tool:"find_owned_alternatives",call_id:source_call_id,result:{owner_check:native}},{tool:"search",call_id:"untrusted",result:{owner_check:native}}]);
  expect(checks).toEqual([f.check]);
  expect(await invoke(setDraftReview,f.ctx,{...f.args,owner_checks:checks})).toMatchObject({ok:true});
  expect(tasks(f)).toHaveLength(1);expect(tasks(f)[0]).toMatchObject({status:"pending",candidate_names:["Sony FX3"],check:{candidate_item_ids:[f.body]}});
  expect(await invoke(setDraft,f.ctx,{thread_id:f.args.thread_id,message_id:f.args.message_id,epoch:f.args.epoch,context_key:f.args.context_key,draft_text:"I'll check the exact recording mode for you.",owner_checks:checks})).toMatchObject({ok:true});
  expect(tasks(f)).toHaveLength(1);
  const bot=await ownerChecksForBot(f.ctx as any,f.args.thread_id,f.args.context_key);
  expect(bot[0]).toMatchObject({kind:"camera_recommendation",customer_input_required:false,specification_result_verified:false,candidate_names:["Sony FX3"]});
 });
 it("deduplicates reordered nested criteria and follow-up questions without losing the original question",async()=>{
  const f=await cameraReview();await invoke(setDraftReview,f.ctx,{...f.args,owner_checks:[f.check]});
  const reordered={...f.check,requirements:{recording:{internal:true,full_width:true,capture_format:"full_frame" as const,min_fps:60,resolution:"dci_4k" as const},sensor_format:"full_frame" as const,role:"interchangeable_lens" as const}};
  expect(ownerCheckScopeKey(reordered)).toBe(ownerCheckScopeKey(f.check));
  await f.ctx.db.insert("hygglo_messages",{thread_id:f.args.thread_id,message_id:"renter-2",sender:"renter",body_text:"Any update?",fetched_at:f.now+1,hygglo_sent_at:f.now+1});
  expect(await invoke(setDraftReview,f.ctx,{...f.args,message_id:"renter-2",owner_checks:[reordered]})).toMatchObject({ok:true});
  expect(tasks(f)).toHaveLength(1);expect(tasks(f)[0]).toMatchObject({source_message_id:"renter-1",source_question:"I need a full-frame camera with uncropped DCI 4K60."});
 });
 it("does not create tasks after current facts resolve the mode or contradict the requested body",async()=>{
  for(const update of ["resolved","incompatible"]){
   const f=await cameraReview();await f.ctx.db.patch(f.specId,{camera_capabilities:{...f.spec.camera_capabilities,...(update==="resolved"?{recording_modes:[{...f.spec.camera_capabilities.recording_modes[0],resolution:"dci_4k"}]}:{sensor_format:"super35"})}});
   await invoke(setDraftReview,f.ctx,{...f.args,owner_checks:[f.check]});expect(tasks(f)).toEqual([]);
  }
 });
 it("refreshes candidates on the same inbound instead of preserving a newly known incompatible body",async()=>{
  const f=await cameraReview();const second=await f.ctx.db.insert("items",{name_canonical:"Sony A7 V",kind:"camera",qty:2,status:"active",is_marketing_only:false});
  const check={...f.check,candidate_item_ids:[f.body,second] as Id<"items">[]};
  await invoke(setDraftReview,f.ctx,{...f.args,owner_checks:[check]});expect(tasks(f)[0].candidate_names).toEqual(["Sony FX3","Sony A7 V"]);
  await f.ctx.db.patch(f.specId,{camera_capabilities:{...f.spec.camera_capabilities,internal_4k:false}});
  await invoke(setDraftReview,f.ctx,{...f.args,owner_checks:[check]});expect(tasks(f)).toHaveLength(1);expect(tasks(f)[0].candidate_names).toEqual(["Sony A7 V"]);
 });
 it("does not reopen a handled follow-up on retry, but creates a new task for a later renter request",async()=>{
  const f=await cameraReview();await invoke(setDraftReview,f.ctx,{...f.args,owner_checks:[f.check]});
  await f.ctx.db.insert("hygglo_messages",{thread_id:f.args.thread_id,message_id:"renter-2",sender:"renter",body_text:"Any update?",fetched_at:f.now+1,hygglo_sent_at:f.now+1});
  const args={...f.args,message_id:"renter-2",owner_checks:[f.check]};await invoke(setDraftReview,f.ctx,args);
  (f.ctx as any).auth={getUserIdentity:async()=>({subject:"test-owner"})};await invoke(handleOwnerCheck,f.ctx,{id:tasks(f)[0]._id,note:"I handled this question myself.",expected_request_message_id:tasks(f)[0].last_requested_message_id??tasks(f)[0].source_message_id});
  await invoke(setDraftReview,f.ctx,args);expect(tasks(f)).toHaveLength(1);expect(tasks(f)[0].last_requested_message_id).toBe("renter-2");
  await f.ctx.db.insert("hygglo_messages",{thread_id:f.args.thread_id,message_id:"renter-3",sender:"renter",body_text:"Please check again before a quote.",fetched_at:f.now+2,hygglo_sent_at:f.now+2});
  await invoke(setDraftReview,f.ctx,{...args,message_id:"renter-3"});expect(tasks(f)).toHaveLength(2);expect(tasks(f)[1].status).toBe("pending");
 });
 it("creates fresh scoped work when the booking context changes during the same renter message",async()=>{
  const f=await cameraReview();await invoke(setDraftReview,f.ctx,{...f.args,owner_checks:[f.check]});
  await f.ctx.db.patch(f.bookingId,{status:"cancelled"});const context=draftContextKey(f.rows.get(f.bookingId));expect(context).not.toBe(f.args.context_key);
  await invoke(setDraftReview,f.ctx,{...f.args,context_key:context,owner_checks:[f.check]});expect(tasks(f)).toHaveLength(2);
  expect(new Set(tasks(f).map(task=>task.key)).size).toBe(2);
 });
 it("records handling without turning the note into specification proof or bot input",async()=>{
  const f=await cameraReview();await invoke(setDraftReview,f.ctx,{...f.args,owner_checks:[f.check]});
  const task=tasks(f)[0];(f.ctx as any).auth={getUserIdentity:async()=>({subject:"test-owner"})};
  expect(await invoke(handleOwnerCheck,f.ctx,{id:task._id,note:"I handled this camera question myself.",expected_request_message_id:task.last_requested_message_id??task.source_message_id})).toMatchObject({ok:true});
  const context=await ownerChecksForBot(f.ctx as any,f.args.thread_id,f.args.context_key);
  expect(context[0]).toMatchObject({status:"handled_by_owner",specification_result_verified:false,customer_input_required:false});
  expect(JSON.stringify(context)).not.toContain("handled this camera question");
 });
 it("handling old work cannot silently suppress a newer renter request",async()=>{
  const f=await cameraReview();await invoke(setDraftReview,f.ctx,{...f.args,owner_checks:[f.check]});
  const task=tasks(f)[0];(f.ctx as any).auth={getUserIdentity:async()=>({subject:"test-owner"})};
  await f.ctx.db.insert("hygglo_messages",{thread_id:f.args.thread_id,message_id:"renter-new",sender:"renter",body_text:"Please check again before quoting.",fetched_at:f.now+1,hygglo_sent_at:f.now+1});
  await invoke(handleOwnerCheck,f.ctx,{id:task._id,note:"I handled the original question.",expected_request_message_id:task.last_requested_message_id??task.source_message_id});
  expect(tasks(f)[0].last_requested_message_id??tasks(f)[0].source_message_id).toBe("renter-1");
  await invoke(setDraftReview,f.ctx,{...f.args,message_id:"renter-new",owner_checks:[f.check]});
  expect(tasks(f)).toHaveLength(2);expect(tasks(f)[1].status).toBe("pending");
 });
 it("rejects closing a task refreshed after the owner opened its handling form",async()=>{
  const f=await cameraReview();await invoke(setDraftReview,f.ctx,{...f.args,owner_checks:[f.check]});
  const task=tasks(f)[0];(f.ctx as any).auth={getUserIdentity:async()=>({subject:"test-owner"})};
  await f.ctx.db.insert("hygglo_messages",{thread_id:f.args.thread_id,message_id:"renter-new",sender:"renter",body_text:"Any update?",fetched_at:f.now+1,hygglo_sent_at:f.now+1});
  await invoke(setDraftReview,f.ctx,{...f.args,message_id:"renter-new",owner_checks:[f.check]});
  await expect(invoke(handleOwnerCheck,f.ctx,{id:task._id,note:"I reviewed the old question.",expected_request_message_id:"renter-1"})).rejects.toThrow("changed");
  expect(tasks(f)[0].status).toBe("pending");
 });
});


describe("Native negotiation history",()=>{
 it("retains objections, competitor evidence and exact alternative offers beyond the chat window",async()=>{
  const f=await setup();const first=[...f.rows.values()].find(r=>r.table==="hygglo_messages");
  await f.ctx.db.patch(first._id,{sender:"renter",body_text:"Too expensive."});
  const offer=(total:number)=>({context_key:"native-context",epoch:2,quoted_for_message_id:first.message_id,
   quote:{quote_key:`native-${total}`,start_date:"2099-10-22",end_date:"2099-10-24",items:[],listing_quote:{total_gbp:total,lines:[]}}});
  const options=[offer(50),offer(100)];
  await f.ctx.db.insert("hygglo_messages",{thread_id:f.args.thread_id,message_id:"competitor",sender:"renter",body_text:"I found it cheaper elsewhere.",hygglo_sent_at:f.now+1,fetched_at:f.now+1});
  await f.ctx.db.insert("hygglo_messages",{thread_id:f.args.thread_id,message_id:"options",sender:"owner",body_text:"Here are two options.",quoted_inquiries:options,hygglo_sent_at:f.now+2,fetched_at:f.now+2});
  for(let i=0;i<56;i++)await f.ctx.db.insert("hygglo_messages",{thread_id:f.args.thread_id,message_id:`logistics-${i}`,sender:i%2?"owner":"renter",body_text:"Collection details can wait for confirmation.",hygglo_sent_at:f.now+3+i,fetched_at:f.now+3+i});
  await f.ctx.db.insert("hygglo_messages",{thread_id:f.args.thread_id,message_id:"latest",sender:"renter",body_text:"Any discount?",hygglo_sent_at:f.now+60,fetched_at:f.now+60});
  expect(await invoke(get_negotiation_stance,f.ctx,{thread_id:f.args.thread_id})).toMatchObject({objectionCount:3,threadObjectionCount:3,stance:"SOFT_YIELD",competitorMentioned:true,lastPriceOfferedGbp:null,lastInquiryOptions:options});
 });
 it("keeps older independent hire identity through long logistics and a genuine new request",async()=>{
  const f=await setup();const first=[...f.rows.values()].find(r=>r.table==="hygglo_messages");
  await f.ctx.db.patch(first._id,{sender:"renter",body_text:"Too expensive."});
  const request={kind:"inquiry",origin_message_id:"independent-hire"};
  await f.ctx.db.insert("hygglo_messages",{thread_id:f.args.thread_id,message_id:request.origin_message_id,sender:"renter",rental_request:request,body_text:"Any discount?",hygglo_sent_at:f.now+1,fetched_at:f.now+1});
  await f.ctx.db.insert("hygglo_messages",{thread_id:f.args.thread_id,message_id:"served",sender:"owner",rental_request:request,body_text:"I can check suitable alternatives.",hygglo_sent_at:f.now+2,fetched_at:f.now+2});
  await f.ctx.db.patch(f.convId,{active_rental_request:request});
  for(let i=0;i<56;i++)await f.ctx.db.insert("hygglo_messages",{thread_id:f.args.thread_id,message_id:`followup-${i}`,sender:i%2?"owner":"renter",body_text:"Collection details can wait for confirmation.",hygglo_sent_at:f.now+3+i,fetched_at:f.now+3+i});
  await f.ctx.db.insert("hygglo_messages",{thread_id:f.args.thread_id,message_id:"latest",sender:"renter",body_text:"Any discount?",hygglo_sent_at:f.now+60,fetched_at:f.now+60});
  expect(await invoke(get_negotiation_stance,f.ctx,{thread_id:f.args.thread_id})).toMatchObject({objectionCount:2,threadObjectionCount:3,stance:"OFFER_ALTERNATIVES",rentalRequest:request});
  expect(await invoke(get_negotiation_stance,f.ctx,{thread_id:f.args.thread_id,rental_request:{kind:"inquiry",origin_message_id:"latest"}})).toMatchObject({objectionCount:1,threadObjectionCount:3,stance:"HOLD_FIRM"});
 });

 it("counts the latest renter objection once and ignores a supplied rewrite",async()=>{
  const f=await setup();const message=[...f.rows.values()].find(r=>r.table==="hygglo_messages");
  await f.ctx.db.patch(message._id,{sender:"renter",body_text:"That is too expensive."});
  for(const latest_message of [undefined,"That is too expensive.","Any discount? I found it cheaper elsewhere."]){
   expect(await invoke(get_negotiation_stance,f.ctx,{thread_id:f.args.thread_id,latest_message})).toMatchObject({objectionCount:1,stance:"HOLD_FIRM",competitorMentioned:false});
  }
 });
 it("does not confuse another hire or delivery arrangements with price objections",async()=>{
  for(const text of ["I want another rental for next month.","Can you do delivery for Tuesday?"]){
   const f=await setup();const message=[...f.rows.values()].find(r=>r.table==="hygglo_messages");await f.ctx.db.patch(message._id,{sender:"renter",body_text:text});
   expect(await invoke(get_negotiation_stance,f.ctx,{thread_id:f.args.thread_id})).toMatchObject({objectionCount:0,stance:"NONE",competitorMentioned:false});
  }
 });
 it("retains actual counteroffers and cheaper competitor comparisons",async()=>{
  for(const text of ["Can you do the lens for £40?","Can you do the lens for 40 pounds?","I found another rental cheaper."]){
   const f=await setup();const message=[...f.rows.values()].find(r=>r.table==="hygglo_messages");await f.ctx.db.patch(message._id,{sender:"renter",body_text:text});
   expect(await invoke(get_negotiation_stance,f.ctx,{thread_id:f.args.thread_id})).toMatchObject({objectionCount:1,stance:"HOLD_FIRM",competitorMentioned:text.includes("cheaper")});
  }
 });
 it("counts separate real repeated objections while excluding owner and system copy",async()=>{
  const f=await setup();const first=[...f.rows.values()].find(r=>r.table==="hygglo_messages");
  await f.ctx.db.patch(first._id,{sender:"renter",body_text:"Any discount?"});
  for(const [index,sender] of ["owner","system","renter"].entries())await f.ctx.db.insert("hygglo_messages",{thread_id:f.args.thread_id,message_id:`turn-${index}`,sender,body_text:"Any discount?",fetched_at:f.now+index+1,hygglo_sent_at:f.now+index+1});
  expect(await invoke(get_negotiation_stance,f.ctx,{thread_id:f.args.thread_id})).toMatchObject({objectionCount:2,stance:"OFFER_ALTERNATIVES"});
  await f.ctx.db.insert("hygglo_messages",{thread_id:f.args.thread_id,message_id:"third-objection",sender:"renter",body_text:"Any discount?",fetched_at:f.now+4,hygglo_sent_at:f.now+4});
  expect(await invoke(get_negotiation_stance,f.ctx,{thread_id:f.args.thread_id})).toMatchObject({objectionCount:3,stance:"SOFT_YIELD"});
 });
 it("does not fabricate negotiation on a thread without renter messages",async()=>{
  const f=await setup();const first=[...f.rows.values()].find(r=>r.table==="hygglo_messages");await f.ctx.db.patch(first._id,{sender:"owner"});
  expect(await invoke(get_negotiation_stance,f.ctx,{thread_id:f.args.thread_id,latest_message:"Any discount?"})).toMatchObject({objectionCount:0,stance:"NONE",competitorMentioned:false});
 });
});

describe('negotiation applies to the current price turn',()=>{
 const history=['That is too expensive.','Any discount?','I found it cheaper elsewhere.'];
 it('keeps history without price pressure on accepted offers or logistics',()=>{
  for(const latestMessage of ['That works, I accept the quote.','Can I collect at 5pm?','Thanks, how do I return it?','I need another rental for next month.']){
   expect(computeNegotiationStance({priorRenterMessages:history,latestMessage})).toMatchObject({stance:'NONE',objectionCount:3,competitorMentioned:true,discountAuthority:'none'});
  }
 });
 it('can resume a genuine price discussion without forgetting real earlier objections',()=>{
  expect(computeNegotiationStance({priorRenterMessages:history,latestMessage:'Can you do the lens for £40?'})).toMatchObject({stance:'SOFT_YIELD',objectionCount:4,discountAuthority:'may_escalate'});
 });
});


describe("Native offered price provenance",()=>{
 it("reads only recorded owner offers and carries their request and date scope",()=>{
  const offer={context_key:"primary-context",epoch:5,quoted_for_message_id:"separate-request",quote:{quote_key:"native-separate",new_inquiry:true as const,start_date:"2026-10-22",end_date:"2026-10-24",items:[{item_id:"sony",name:"Sony lens",quantity:1}],listing_quote:{total_gbp:50,lines:[{product_id:123,name:"Sony lens",quantity:1,total_gbp:50}]}}};
  const text={sender:"renter",body_text:"Any discount?"};
  expect(negotiationFromMessages([{sender:"owner",body_text:"Total: £50",quoted_inquiries:[offer]},text])).toMatchObject({lastPriceOfferedGbp:50,lastInquiryOffer:offer});
  expect(negotiationFromMessages([{...text,quoted_inquiries:[offer]}])).toMatchObject({lastPriceOfferedGbp:null,lastInquiryOffer:null});
  expect(negotiationFromMessages([{sender:"owner",body_text:"Total: £500"},text])).toMatchObject({lastPriceOfferedGbp:null,lastInquiryOffer:null});
 });
});


describe('discount eligibility comes from Native evidence',()=>{
 it('does not let a caller flag approve a discount or fabricate a reduced catalogue total',async()=>{
  const f=database();
  await f.ctx.db.insert('items',{name_canonical:'Sony FX3',status:'active',qty:2,is_marketing_only:false,kind:'camera'});
  await f.ctx.db.insert('pricing_catalog',{item_name_canonical:'Sony FX3',daily_price_min:40,daily_price_max:40,marketing_only:false,is_bundle:false});
  for(const days of [1,3])for(const listing_location_non_central of [undefined,false,true]){
   const result=await invoke(lookup_pricing,f.ctx,{item_name:'Sony FX3',days,quantity:1,listing_location_non_central});
   expect(result).toMatchObject({found:true,distance_discount_applies:null,distance_discount_verification:'unverified',listed_total_gbp:days===1?40:null});
  }
 });
});


it('retains the latest Native alternative group without treating its last option as the selected price',()=>{
 const scope={context_key:'booking',epoch:2,quoted_for_message_id:'request'};
 const quote={quote_key:'a',new_inquiry:true as const,start_date:'2026-10-22',end_date:'2026-10-24',items:[{item_id:'sony',name:'Sony lens',quantity:1}],listing_quote:{total_gbp:50,lines:[{product_id:123,name:'Sony lens',quantity:1,total_gbp:50}]}};
 const options=[{...scope,quote},{...scope,quote:{...quote,quote_key:'b',end_date:'2026-10-28',listing_quote:{total_gbp:90,lines:[{product_id:123,name:'Sony lens',quantity:1,total_gbp:90}]}}}];
 const result=negotiationFromMessages([{sender:'owner',body_text:'Two options',quoted_inquiries:options},{sender:'renter',body_text:'Any discount?'}]);
 expect(result).toMatchObject({lastPriceOfferedGbp:null,lastInquiryOffer:null,lastInquiryOptions:options,objectionCount:1,stance:'HOLD_FIRM'});
 expect(negotiationFromMessages([{sender:'owner',body_text:'Two options',quoted_inquiries:options},{sender:'owner',body_text:'Chosen exact Native offer',quoted_inquiries:[options[0]]}])).toMatchObject({lastPriceOfferedGbp:50,lastInquiryOffer:options[0]});
});


describe("negotiation rental request identity",()=>{
 const first={kind:"inquiry",origin_message_id:"new-hire"} as const;
 const next={kind:"inquiry",origin_message_id:"later-hire"} as const;
 const primary={kind:"primary"} as const;
 const history:any[]=[
  {message_id:"old",sender:"renter",body_text:"Too expensive"},
  {message_id:"old2",sender:"renter",body_text:"Any discount?"},
  {message_id:"new-hire",sender:"renter",body_text:"A separate hire please. Any discount?",rental_request:first},
  {sender:"owner",body_text:"Here are the options",rental_request:first},
  {sender:"renter",body_text:"Could we change dates?",rental_request:first},
  {sender:"owner",body_text:"Updated dates",rental_request:first},
  {sender:"renter",body_text:"Any discount?"},
 ];
 it("keeps date and equipment alternatives in the same hire without inheriting older objections",()=>{
  expect(negotiationFromMessages(history)).toMatchObject({objectionCount:2,stance:"OFFER_ALTERNATIVES",threadObjectionCount:4,rentalRequest:first});
 });
 it("starts a later hire at its actual inbound anchor before a reply is sent",()=>{
  const messages=[...history,{message_id:"later-hire",sender:"renter",body_text:"For another shoot, any discount?"}];
  expect((negotiationFromMessages as any)(messages,next)).toMatchObject({objectionCount:1,stance:"HOLD_FIRM",threadObjectionCount:5,rentalRequest:next});
 });
 it("can return to primary booking history without importing independent hire objections",()=>{
  expect((negotiationFromMessages as any)([...history,{sender:"renter",body_text:"Back to my original booking, any discount?"}],primary)).toMatchObject({objectionCount:3,threadObjectionCount:5,rentalRequest:primary});
 });
});


describe("authoritative owner lens reviews",()=>{
 async function lensReview(){
  const f=await setup();(f.ctx as any).auth={getUserIdentity:async()=>({issuer:"urn:rental-manager:deployment-service",subject:"rental-manager-service"})};
  await f.ctx.db.patch(f.convId,{account_slug:"leo"});
  const lens=await f.ctx.db.insert("items",{name_canonical:"Unknown 11mm lens",kind:"lens",lens_mount:"E",qty:1,status:"active",is_marketing_only:false});
  const spec=await f.ctx.db.insert("item_specs",{item_id:lens,item_name_canonical:"Unknown 11mm lens",description:"Legacy autofocus claim",specs_long:"Unverified extra promises",source:"legacy",lens_variant_reviews:[]});
  const check={kind:"lens_recommendation",candidate_item_ids:[lens],requirements:{focus_mode:"manual_focus",macro:true},lens_mount:"E",quantity:1,start_date:null,end_date:null};
  const task=await f.ctx.db.insert("renter_bot_owner_checks",{thread_id:f.args.thread_id,account_slug:"leo",status:"pending",source_message_id:f.args.message_id,source_context_key:f.args.context_key,check,candidate_names:["Unknown 11mm lens"]});
  const review=await invoke(getLensReview,f.ctx,{task_id:task,item_id:lens});expect(review.available).toBe(true);expect(review.reviewed).toBeNull();
  const args={task_id:task,item_id:lens,expected_request_message_id:review.request_message_id,expected_revision:review.revision,model:"TTArtisan 11mm f/2.8",source_url:"https://manufacturer.example/11mm",facts:{focus_mode:"manual_focus",focal_min_mm:11,focal_max_mm:11},confirmed_model:true};
  return {...f,lens,spec,task,review,reviewArgs:args};
 }
 it("saves source-backed partial facts, refreshes bot evidence and keeps workflow and inventory independent",async()=>{
  const f=await lensReview(),before=structuredClone(f.rows.get(f.lens));
  expect(await invoke(reviewLensSpecification,f.ctx,f.reviewArgs)).toMatchObject({ok:true,preview:false,assessment:{status:"unknown",unknown:["macro"]},verified:{focus_mode:"manual_focus",focal_min_mm:11}});
  expect(f.rows.get(f.spec)).toMatchObject({source:"owner-verified",verified_model:f.reviewArgs.model,lens_capabilities:{focus_mode:"manual_focus"}});
  expect(f.rows.get(f.spec).lens_variant_reviews).toBeUndefined();expect(f.rows.get(f.spec).specs_long).toBeUndefined();expect(f.rows.get(f.spec).description).not.toContain("autofocus");
  expect(f.rows.get(f.lens)).toEqual(before);expect(f.rows.get(f.task).status).toBe("pending");
  expect([...f.rows.values()].find(r=>r.table==="settings").draft_epoch).toBe(3);
  expect([...f.rows.values()].filter(r=>r.table==="audit_log")).toHaveLength(1);
  expect((await ownerChecksForBot(f.ctx as any,f.args.thread_id,f.args.context_key))[0]).toMatchObject({specification_result_verified:false,current_specification_reviews:[{status:"unknown",unknown:["macro"]}]});
  const fresh=await invoke(getLensReview,f.ctx,{task_id:f.task,item_id:f.lens});
  await invoke(reviewLensSpecification,f.ctx,{...f.reviewArgs,expected_revision:fresh.revision,facts:{...f.reviewArgs.facts,macro:false}});
  expect((await ownerChecksForBot(f.ctx as any,f.args.thread_id,f.args.context_key))[0]).toMatchObject({current_specification_reviews:[{status:"mismatch",mismatched:["macro"]}]});
 });
 it("requires owner authorization even when the optional app enforcement flag is disabled",async()=>{
  const f=await lensReview();(f.ctx as any).auth={getUserIdentity:async()=>null};
  const before=structuredClone([...f.rows]);await expect(invoke(reviewLensSpecification,f.ctx,{...f.reviewArgs,dry_run:true})).rejects.toThrow("OWNER_AUTH_REQUIRED");expect([...f.rows]).toEqual(before);
 });
 it("previews without altering the catalogue, epoch, audit trail or task",async()=>{
  const f=await lensReview(),before=structuredClone([...f.rows]);
  expect(await invoke(reviewLensSpecification,f.ctx,{...f.reviewArgs,dry_run:true})).toMatchObject({ok:true,preview:true});expect([...f.rows]).toEqual(before);
 });
 it("rejects stale record or refreshed renter work before any writes",async()=>{
  for(const changed of ["record","request"]){const f=await lensReview();
   if(changed==="record")await f.ctx.db.patch(f.spec,{description:"A later reviewed record"});else await f.ctx.db.patch(f.task,{last_requested_message_id:"new-renter-message"});
   const before=structuredClone([...f.rows]);await expect(invoke(reviewLensSpecification,f.ctx,f.reviewArgs)).rejects.toThrow("changed");expect([...f.rows]).toEqual(before);
  }
 });
 it("rejects invalid sources, unchecked identity, empty facts and impossible numeric or focus records",async()=>{
  for(const patch of [{source_url:"http://manufacturer.example"},{confirmed_model:false},{facts:{}},{facts:{focal_min_mm:20}},{facts:{focal_min_mm:20,focal_max_mm:11}},{facts:{max_aperture_f:0}},{facts:{focus_mode:"manual_focus",manual_focus_available:false}}]){
   const f=await lensReview(),before=structuredClone([...f.rows]);await expect(invoke(reviewLensSpecification,f.ctx,{...f.reviewArgs,...patch})).rejects.toThrow();expect([...f.rows]).toEqual(before);
  }
 });
 it("cannot review foreign candidates, duplicates, handled tasks or ineligible inventory",async()=>{
  for(const invalid of ["foreign","duplicate","handled","marketing","inactive"]){const f=await lensReview();
   if(invalid==="foreign")await f.ctx.db.patch(f.task,{check:{...f.rows.get(f.task).check,candidate_item_ids:[]}});
   if(invalid==="duplicate")await f.ctx.db.insert("item_specs",{item_id:f.lens,description:"duplicate"});
   if(invalid==="handled")await f.ctx.db.patch(f.task,{status:"handled_by_owner"});
   if(invalid==="marketing")await f.ctx.db.patch(f.lens,{is_marketing_only:true});if(invalid==="inactive")await f.ctx.db.patch(f.lens,{status:"inactive"});
   expect(await invoke(getLensReview,f.ctx,{task_id:f.task,item_id:f.lens})).toMatchObject({available:false});
   const before=structuredClone([...f.rows]);await expect(invoke(reviewLensSpecification,f.ctx,f.reviewArgs)).rejects.toThrow();expect([...f.rows]).toEqual(before);
  }
 });
});


describe("authoritative camera reviews retain independent evidence",()=>{
 async function camera(){
  const f=await setup();(f.ctx as any).auth={getUserIdentity:async()=>({issuer:"urn:rental-manager:deployment-service",subject:"rental-manager-service"})};
  const item=await f.ctx.db.insert("items",{name_canonical:"Sony FX3",kind:"camera",lens_mount:"E",qty:2,status:"active",is_marketing_only:false});
  const mode={resolution:"uhd_4k",nominal_fps:[60],capture_format:"full_frame",full_width:true,internal:true,conditions:["Use the reviewed setting"],verified_model:"Sony FX3",source_url:"https://manufacturer.example/modes",verified_at:2};
  const spec=await f.ctx.db.insert("item_specs",{item_id:item,item_name_canonical:"Sony FX3",description:"Reviewed original profile",source:"manufacturer-verified",source_url:"https://manufacturer.example/fx3",verified_model:"Sony FX3",verified_at:1,
   camera_capabilities:{role:"interchangeable_lens",sensor_format:"full_frame",native_mount:"E",internal_4k:true,verified_model:"Sony FX3",source_url:"https://manufacturer.example/fx3",verified_at:1,recording_modes:[mode]}});
  const task=await f.ctx.db.insert("renter_bot_owner_checks",{status:"pending",source_message_id:f.args.message_id,check:{kind:"camera_recommendation",candidate_item_ids:[item],requirements:{recording:{resolution:"uhd_4k",min_fps:60,internal:true}},quantity:1,lens_mount:null}});
  const review=await invoke(getCameraReview,f.ctx,{task_id:task,item_id:item});expect(review.available).toBe(true);
  const args={task_id:task,item_id:item,expected_request_message_id:review.request_message_id,expected_revision:review.revision,confirmed_model:true};
  const change={kind:"profile",model:"Sony FX3",source_url:"https://manufacturer.example/current-profile",role:"interchangeable_lens",sensor_format:"full_frame",native_mount:"E",internal_4k:true,built_in_nd:false};
  return {...f,item,spec,task,mode,review,reviewArgs:args,change};
 }
 it("updates a same-model profile without changing the recording source/date or original stock",async()=>{
  const f=await camera(),original=structuredClone(f.rows.get(f.item));
  const result=await invoke(saveCameraReview,f.ctx,{...f.reviewArgs,change:{...f.change,native_mount:"L"}});
  expect(result).toMatchObject({ok:true,assessment:{status:"match"}});expect(result.verified.recording_modes).toEqual([f.mode]);
  expect(f.rows.get(f.spec).camera_capabilities.identity_review).toEqual({verified_model:"Sony FX3",verified_at:1});
  expect(f.rows.get(f.spec).verified_at).toBeGreaterThan(2);expect(f.rows.get(f.spec).camera_capabilities.recording_modes).toEqual([f.mode]);
  expect(f.rows.get(f.item)).toMatchObject({qty:original.qty,lens_mount:"L"});expect(f.rows.get(f.task).status).toBe("pending");
  expect([...f.rows.values()].find(r=>r.table==="settings").draft_epoch).toBe(3);expect([...f.rows.values()].filter(r=>r.table==="audit_log")).toHaveLength(1);
  expect(result.verified.identity_review).toBeUndefined();
 });
 it("does not carry modes to a different physical model",async()=>{
  const f=await camera();const result=await invoke(saveCameraReview,f.ctx,{...f.reviewArgs,change:{...f.change,model:"Sony FX3 alternate model"}});
  expect(result.assessment).toMatchObject({status:"unknown",unknown:["recording"]});expect(result.verified.recording_modes).toEqual([]);
  expect(f.rows.get(f.spec).camera_capabilities.recording_modes).toBeUndefined();
 });
 it("corrects one mode without rewriting profile provenance, ND or other modes",async()=>{
  const f=await camera(),before=structuredClone(f.rows.get(f.spec));
  const change={kind:"recording_mode",resolution:"dci_4k",source_url:"https://manufacturer.example/dci-external",nominal_fps:[60,24,60],full_width:false,internal:false,conditions:["External recorder required"]};
  const result=await invoke(saveCameraReview,f.ctx,{...f.reviewArgs,change});
  expect(result.verified.recording_modes[0]).toEqual(f.mode);expect(result.verified.recording_modes[1]).toMatchObject({nominal_fps:[24,60],internal:false,conditions:change.conditions});
  const current=f.rows.get(f.spec);expect(current.source_url).toBe(before.source_url);expect(current.verified_at).toBe(before.verified_at);expect(current.camera_capabilities.built_in_nd).toBeUndefined();
  expect(current.camera_capabilities.recording_modes[1].capture_format).toBeUndefined();
 });
 it("preserves contradictory mode references for review while excluding them from public claims",async()=>{
  const f=await camera();await invoke(saveCameraReview,f.ctx,{...f.reviewArgs,change:{...f.change,internal_4k:false}});
  const read=await invoke(getCameraReview,f.ctx,{task_id:f.task,item_id:f.item});expect(read.recording_reviews).toEqual([f.mode]);expect(read.profile.recording_modes).toEqual([]);
  const result=await invoke(saveCameraReview,f.ctx,{...f.reviewArgs,expected_revision:read.revision,change:{kind:"recording_mode",mode_index:0,resolution:"uhd_4k",source_url:"https://manufacturer.example/external",nominal_fps:[60],full_width:true,internal:false,conditions:["External recorder required"]}});
  expect(result.verified.recording_modes).toHaveLength(1);expect(result.verified.recording_modes[0].internal).toBe(false);
 });
 it("rejects stale, invalid, impossible and unauthorized reviews without writes",async()=>{
  for(const invalid of ["stale","unauthorized","unchecked","source","fps","index","sensor"]){
   const f=await camera();let args:any={...f.reviewArgs,change:{kind:"recording_mode",resolution:"uhd_4k",source_url:"https://manufacturer.example/mode",nominal_fps:[60],full_width:true,internal:true,conditions:[]}};
   if(invalid==="stale")args.expected_revision="old";if(invalid==="unchecked")args.confirmed_model=false;
   if(invalid==="unauthorized")(f.ctx as any).auth={getUserIdentity:async()=>null};if(invalid==="source")args.change.source_url="http://example.com";
   if(invalid==="fps")args.change.nominal_fps=[0];if(invalid==="index")args.change.mode_index=3;
   if(invalid==="sensor"){const row=f.rows.get(f.spec);await f.ctx.db.patch(f.spec,{camera_capabilities:{...row.camera_capabilities,sensor_format:"aps_c"}});args.expected_revision=(await invoke(getCameraReview,f.ctx,{task_id:f.task,item_id:f.item})).revision;args.change.capture_format="full_frame";}
   const before=structuredClone([...f.rows]);await expect(invoke(saveCameraReview,f.ctx,args)).rejects.toThrow();expect([...f.rows]).toEqual(before);
  }
 });
 it("previews against real readers without touching catalogue, mount, epoch or task",async()=>{
  const f=await camera(),before=structuredClone([...f.rows]);
  const preview=await invoke(saveCameraReview,f.ctx,{...f.reviewArgs,change:{...f.change,native_mount:"L"},dry_run:true});expect(preview.verified.recording_modes).toEqual([f.mode]);expect([...f.rows]).toEqual(before);
 });
});


describe("physical mapping writes invalidate actual draft approvals",()=>{
 async function mapping(){
  const f=await setup();(f.ctx as any).auth={getUserIdentity:async()=>({issuer:"urn:rental-manager:deployment-service",subject:"rental-manager-service"})};
  const camera=await f.ctx.db.insert("items",{name_canonical:"Sony FX3",kind:"camera",qty:2,status:"active",is_marketing_only:false});
  const battery=await f.ctx.db.insert("items",{name_canonical:"NP-F570 battery",kind:"power",qty:12,status:"active",is_marketing_only:false,track_independent_stock:true});
  await f.ctx.db.insert("hygglo_products",{accountSlug:"leo",productId:123,name:"Sony FX3"});
  const override=await f.ctx.db.insert("listing_resolution_override",{account_slug:"leo",product_id:123,components:[{item_id:camera,qty:1}],source:"manual_audit",updated_at:1});
  const row=(await invoke(getOverrides,f.ctx,{}))[0];const args={account_slug:"leo",product_id:123,components:[{item_id:camera,qty:1},{item_id:battery,qty:5}],expected_revision:row.revision,note:"Owner checked physical contents"};
  return {...f,camera,battery,override,row,writeArgs:args};
 }
 it("records the actual shared-stock mapping, audits it and removes an old draft's approval",async()=>{
  const f=await mapping();await invoke(setDraft,f.ctx,{thread_id:f.args.thread_id,message_id:f.args.message_id,epoch:2,context_key:f.args.context_key,draft_text:"I will check the kit contents."});
  expect((await invoke(getDraftApprovalContext,f.ctx,{thread_id:f.args.thread_id})).draft_approval).not.toBeNull();
  const originalCamera=structuredClone(f.rows.get(f.camera)),originalBattery=structuredClone(f.rows.get(f.battery));
  expect(await invoke(setOverride,f.ctx,f.writeArgs)).toMatchObject({updated:1});
  const physical=await loadListingInventory(f.ctx as any,"leo",123,2);
  expect(physical).toMatchObject({complete:true,owned:true});expect(physical.components.find(c=>c.item_id===f.battery)).toMatchObject({units_per_listing:5,requested_units:10,stock_required:true});
  expect(f.rows.get(f.camera)).toEqual(originalCamera);expect(f.rows.get(f.battery)).toEqual(originalBattery);expect(f.rows.get(f.settingsId).draft_epoch).toBe(3);
  expect((await invoke(getDraftApprovalContext,f.ctx,{thread_id:f.args.thread_id})).draft_approval).toBeNull();
  const audit=[...f.rows.values()].filter(r=>r.table==="audit_log");expect(audit).toHaveLength(1);expect(JSON.parse(audit[0].note)).toMatchObject({before:{_id:f.override},after:{components:expect.arrayContaining([{item_id:f.battery,qty:5}])}});
 });
 it("previews normalized duplicate quantities without editing stock, mapping, audit or epoch",async()=>{
  const f=await mapping(),before=structuredClone([...f.rows]);
  const result=await invoke(setOverride,f.ctx,{...f.writeArgs,dry_run:true,components:[{item_id:f.camera,qty:1},{item_id:f.battery,qty:2},{item_id:f.battery,qty:3}]});
  expect(result).toMatchObject({preview:true,components:expect.arrayContaining([{item_id:f.battery,qty:5}])});expect(result.components).toHaveLength(2);expect([...f.rows]).toEqual(before);
 });
 it("requires owner authorization for writes, removals and previews even during global rollout",async()=>{
  for(const [fn,args] of [[setOverride,{dry_run:true}],[setOverride,{}],[removeOverride,{dry_run:true}],[removeOverride,{}]] as const){
   const f=await mapping();(f.ctx as any).auth={getUserIdentity:async()=>null};const before=structuredClone([...f.rows]);
   await expect(invoke(fn,f.ctx,{...f.writeArgs,...args})).rejects.toThrow("OWNER_AUTH_REQUIRED");expect([...f.rows]).toEqual(before);
  }
 });
 it("rejects invalid physical units, excess pooled units, non-owned inventory and foreign targets without writes",async()=>{
  for(const invalid of ["zero","negative","fraction","nan","excess","summed_excess","missing","marketing","inactive","unknown_listing","foreign_account","product_zero","note_limit"]){
   const f=await mapping();let args:any={...f.writeArgs};
   if(["zero","negative","fraction","nan","excess"].includes(invalid))args.components=[{item_id:f.battery,qty:({zero:0,negative:-1,fraction:0.5,nan:NaN,excess:13} as any)[invalid]}];
   if(invalid==="summed_excess")args.components=[{item_id:f.battery,qty:7},{item_id:f.battery,qty:6}];
   if(invalid==="missing")args.components=[{item_id:"items:missing",qty:1}];
   if(invalid==="marketing")await f.ctx.db.patch(f.battery,{is_marketing_only:true});if(invalid==="inactive")await f.ctx.db.patch(f.battery,{status:"inactive"});
   if(invalid==="unknown_listing")args.product_id=124;if(invalid==="foreign_account")args.account_slug="other";if(invalid==="product_zero")args.product_id=0;if(invalid==="note_limit")args.note="x".repeat(2001);
   const before=structuredClone([...f.rows]);await expect(invoke(setOverride,f.ctx,args)).rejects.toThrow();expect([...f.rows]).toEqual(before);
  }
 });
 it("refuses stale or duplicate mappings for both updates and removals",async()=>{
  for(const fn of [setOverride,removeOverride])for(const invalid of ["stale","duplicate"]){const f=await mapping();
   if(invalid==="duplicate")await f.ctx.db.insert("listing_resolution_override",{...f.rows.get(f.override),_id:undefined});
   const args={...f.writeArgs,expected_revision:invalid==="stale"?"stale":f.row.revision},before=structuredClone([...f.rows]);
   await expect(invoke(fn,f.ctx,args)).rejects.toThrow();expect([...f.rows]).toEqual(before);
  }
 });
 it("removes a mapping with an audit and invalidation, restoring the Native unknown state",async()=>{
  const f=await mapping();await f.ctx.db.insert("hygglo_product_index",{account_slug:"leo",product_id:123,item_id:f.camera});
  expect(await invoke(removeOverride,f.ctx,{account_slug:"leo",product_id:123,expected_revision:f.row.revision})).toEqual({deleted:1});
  expect(f.rows.has(f.override)).toBe(false);expect(f.rows.get(f.settingsId).draft_epoch).toBe(3);expect([...f.rows.values()].filter(r=>r.table==="audit_log")).toHaveLength(1);
  expect((await loadListingInventory(f.ctx as any,"leo",123)).complete).toBe(false);
  expect(await invoke(removeOverride,f.ctx,{account_slug:"leo",product_id:123})).toEqual({deleted:0});expect(f.rows.get(f.settingsId).draft_epoch).toBe(3);
 });
 it("keeps old observed fee listings pinnable and reads only the scoped revision",async()=>{
  const f=await mapping();expect(await invoke(getMappingRevision,f.ctx,{account_slug:"leo",product_id:123})).toEqual({available:true,revision:f.row.revision});
  await f.ctx.db.insert("hygglo_product_index",{account_slug:"leo",product_id:125,item_id:f.camera});
  expect(await invoke(setOverride,f.ctx,{account_slug:"leo",product_id:125,components:[],expected_revision:"null"})).toMatchObject({inserted:1});
  await f.ctx.db.insert("listing_resolution_override",{account_slug:"leo",product_id:123,components:[]});
  expect(await invoke(getMappingRevision,f.ctx,{account_slug:"leo",product_id:123})).toMatchObject({available:false});
 });
 it("supports an explicit non-rentable mapping and an authenticated new listing mapping",async()=>{
  const f=await mapping();await invoke(setOverride,f.ctx,{...f.writeArgs,components:[]});expect(await loadListingInventory(f.ctx as any,"leo",123)).toMatchObject({owned:false});
  await f.ctx.db.insert("online_listings",{account_slug:"leo",product_id:124,name:"NP-F570"});
  expect(await invoke(setOverride,f.ctx,{account_slug:"leo",product_id:124,components:[{item_id:f.battery,qty:1}],expected_revision:"null"})).toMatchObject({inserted:1});
  expect(f.rows.get(f.settingsId).draft_epoch).toBe(4);expect([...f.rows.values()].filter(r=>r.table==="audit_log")).toHaveLength(2);
 });
});


it("persists and returns a failed Lab run's real diagnostics, cost and boundary flags",async()=>{
 const f=database(),error={http_status:502,error_code:"invalid_model_output",transient:false,model_id:"google/gemini-3.7-flash",cost_usd:0.0125,request_id:"native-output-failure",output_diagnostics:{object_type:"missing",text_status:"empty",text_length:0,object_issues:[{field:"$",code:"invalid_type"}],text_issues:[],finish_reason:"tool-calls",step_count:3,tool_call_count:4}};
 const flags=[{type:"INVALID_MODEL_OUTPUT",severity:"critical",action:"flagged",detail:"Model output invalid"}],mutations:string[]=[];
 const ctx={runQuery:async(ref:any)=>{const name=getFunctionName(ref);return name.endsWith("getConversationForThread")?{account_slug:"leo"}:name.endsWith("pendingOwnerChecksForDraft")?[]:null;},
  runAction:async()=>({status:"skipped",reason:"needs_human:invalid_model_output",generation_error:error,review:{flags}}),
  runMutation:async(ref:any,args:any)=>{const name=getFunctionName(ref);mutations.push(name);return name.endsWith("insertRun")?invoke(insertRun,f.ctx,args):null;}};
 const result=await invoke(sendTestMessage,ctx,{threadId:"__probe__failure-telemetry",accountSlug:"leo",text:"Check my camera kit"});
 expect(result).toMatchObject({draft:"",status:"skipped",generation_error:error,productionGuardFlags:flags});
 const row=[...f.rows.values()].find(r=>r.table==="renter_bot_harness_runs");expect(row).toMatchObject({model_id:error.model_id,cost_usd:error.cost_usd,generation_error:error,overall_status:"fail"});
 expect(mutations.some(n=>n.endsWith("appendAssistantMessage"))).toBe(false);
});
