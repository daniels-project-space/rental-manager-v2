import {describe,it,expect} from "vitest";
import jointNativeQuote from "./fixtures/renter-joint-native-quote.json";
import {renterPriceEvidence} from "./renter-price-evidence";
import type {ToolReceipt} from "./renter-tool-evidence";
import {unsupportedPriceClaims} from "../../convex/lib/price_claims";
import {draftEvidenceValidator} from "../../convex/lib/renter_draft_evidence";
const receipt=(tool:string,result:Record<string,unknown>,call_id="call"):ToolReceipt=>({tool,result,call_id});
describe("server price receipt adapters",()=>{
 it("binds an exact quote's short name only to the verified account and listing",()=>{
  const listing="Sony A7 ii mirrorless Camera full frame digital cinema + 28-70mm Zoom FE Sony lens + 128gb sd card Sony a7ii";
  const native={found:true,matched_listing:listing,product_id:1172846,account_slug:"leo",days:2,quantity:1,daily_rate_gbp:28,listed_total_gbp:56,source:"hygglo_tier"};
  const identities=[{account_slug:"leo",product_id:1172846,names:["Sony A7 II",listing]}];
  const request={items:[{name:"Sony A7 II",quantity:1}]};
  const claim="Yes, the Sony A7 II kit is available for the 6th to the 7th of October. For the 2 days, the total comes to £56.";
  expect(unsupportedPriceClaims(claim,renterPriceEvidence([receipt("lookup_pricing",native)],identities),request)).toEqual([]);
  const evidence=renterPriceEvidence([receipt("lookup_pricing",native)],identities);
  const durationFirst="Yes, the Sony A7 II kit is available from the 6th to the 7th of October. For 2 days, the total is £56.";
  expect(unsupportedPriceClaims(durationFirst,evidence,request)).toEqual([]);
  expect(unsupportedPriceClaims(durationFirst.replace("For 2 days","For 4 days"),evidence,request)).not.toEqual([]);
  expect(unsupportedPriceClaims(durationFirst.replace("For 2 days","For the Pyxis"),evidence,request)).not.toEqual([]);
  for(const changed of [{...native,product_id:1172847},{...native,account_slug:"diogo"},{...native,account_slug:undefined}]){
   const proof=renterPriceEvidence([receipt("lookup_pricing",changed)],identities);
   expect(proof[0].names).not.toContain("Sony A7 II");
   expect(unsupportedPriceClaims(claim,proof,request)).not.toEqual([]);
  }
 });
 it("keeps exact alternative duration, quantity and base separate",()=>{
  const result=renterPriceEvidence([receipt("find_owned_alternatives",{alternatives:[{name:"BMPCC 6K Pro",daily_price_gbp:35,quote:{days:3,quantity:2,daily_rate_gbp:30,listed_total_gbp:180,source:"hygglo_tier",start_date:"2026-10-02",end_date:"2026-10-04"}}]})]);
  expect(result[0]).toMatchObject({names:["BMPCC 6K Pro"],days:3,quantity:2,daily_rate_gbp:30,base_rate_gbp:35,total_gbp:180,start_date:"2026-10-02"});
 });
 it("does not treat arbitrary numeric keys or failed results as rental evidence",()=>{
  expect(renterPriceEvidence([receipt("knowledge_search",{daily_price:99,total_gbp:99}),receipt("lookup_pricing",{found:false,matched_listing:"FX3",days:1,quantity:1,daily_rate_gbp:99}),receipt("find_owned_alternatives",{alternatives:[{name:"Unknown",daily_price_gbp:99,price_requires_owner_confirmation:true}]})])).toEqual([]);
 });
 it("does not treat the model's echoed item_name as verified identity",()=>{
  expect(renterPriceEvidence([receipt("lookup_pricing",{found:true,item_name:"Pyxis",days:1,quantity:1,daily_rate_gbp:40,listed_total_gbp:40})])).toEqual([]);
 });
 it("keeps an unverified multi-day catalog rate as base-only evidence",()=>{
  const got=renterPriceEvidence([receipt("lookup_pricing",{found:true,matched_canonical:"Sony FX3",days:3,quantity:1,daily_rate_gbp:40,listed_total_gbp:null,source:"curated_catalog",multi_day_basis:"unknown_no_listing"})]);
  expect(got[0]).toMatchObject({base_rate_gbp:40});expect(got[0].daily_rate_gbp).toBeUndefined();expect(got[0].total_gbp).toBeUndefined();
 });
 it("retains only the latest authoritative Lab order after a modification",()=>{
  const old=receipt("get_lab_order",{days:3,lines:[{name:"FX3",qty:1,effective_rate_gbp:30,line_total_gbp:90}],total_gbp:90},"before");
  const next=receipt("get_lab_order",{days:4,lines:[{name:"FX3",qty:2,effective_rate_gbp:30,line_total_gbp:240}],total_gbp:240},"after");
  const got=renterPriceEvidence([old,next]);expect(got).toHaveLength(2);expect(got.every(g=>g.days===4)).toBe(true);expect(got.find(g=>g.kind==="basket")?.total_gbp).toBe(240);
 });
});

it("binds a complete read-only proposal to its thread, base basket, addition, dates and conditional claim",()=>{
 const base=[{name:"Sony A7 II",quantity:1}], added=[{name:"Sony 28-70mm",quantity:1}];
 const quote={days:2,start_date:"2026-10-06",end_date:"2026-10-07",lines:[{name:"Sony A7 II",qty:1,line_total_gbp:56},{name:"Sony 28-70mm",qty:1,line_total_gbp:36}],total_gbp:92};
 const native={ok:true,preview_only:true,source:"native_lab_proposal",thread_id:"__probe__quote",base_items:base,added_items:added,quote};
 const scope={items:base,start_date:quote.start_date,end_date:quote.end_date};
 const proof=renterPriceEvidence([receipt("quote_booking_addition",native)],[],native.thread_id);
 const claim="One extra Sony 28-70mm would bring your booking total to £92.";
 expect(unsupportedPriceClaims(claim,proof,scope)).toEqual([]);
 const baseProof={...proof[0],proposal:undefined,items:base,total_gbp:56};
 const fromTo="One extra Sony 28-70mm would bring your booking total from £56 to £92.";
 expect(unsupportedPriceClaims(fromTo,[baseProof,...proof],scope)).toEqual([]);
 expect(unsupportedPriceClaims(fromTo,[baseProof],scope)).toHaveLength(1);
 expect(unsupportedPriceClaims(fromTo.replace("£56","£55"),[baseProof,...proof],scope)).toHaveLength(1);

 const unchanged={...proof[0],proposal:undefined,items:base,total_gbp:56};
 expect(unsupportedPriceClaims(claim.replace("£92","£56"),[unchanged],scope)).toHaveLength(1);

 const nativeLens={found:true,matched_canonical:"Sony 28-70mm",days:2,quantity:1,daily_rate_gbp:18,listed_total_gbp:36,source:"hygglo_tier",start_date:quote.start_date,end_date:quote.end_date};
 const actual="An extra Sony 28-70mm lens would cost £36 for the 2 days (6 to 7 October). Adding it would bring your complete booking total to £92.";
 const fullProof=[...proof,...renterPriceEvidence([receipt("lookup_pricing",nativeLens)])];
 expect(unsupportedPriceClaims(actual,fullProof,scope)).toEqual([]);
 const declined="Adding that 1 extra Sony 28-70mm lens would bring the total to £92 for the 2 days.";
 expect(unsupportedPriceClaims(declined,proof,scope)).toEqual([]);
 expect(unsupportedPriceClaims(declined,[{...proof[0],proposal:undefined,items:base,total_gbp:56}],scope)).toHaveLength(1);
 expect(unsupportedPriceClaims(declined.replace("£92","£56"),[{...proof[0],proposal:undefined,items:base,total_gbp:56}],scope)).toHaveLength(1);

 expect(unsupportedPriceClaims(actual.replace("would bring","brings"),fullProof,scope)).toHaveLength(1);

 for(const text of [claim.replace("would bring","brings"),claim.replace("One extra","Two extra"),claim.replace("Sony 28-70mm","Sony GM 24-70mm"),claim.replace("£92","£100")])expect(unsupportedPriceClaims(text,proof,scope),text).toHaveLength(1);
 expect(unsupportedPriceClaims(claim,proof,{...scope,items:[{name:"Sony A7 III",quantity:1}]})).toHaveLength(1);
 expect(unsupportedPriceClaims(claim,proof,{...scope,end_date:"2026-10-08"})).toHaveLength(1);
 expect(renterPriceEvidence([receipt("quote_booking_addition",native)],[],"__probe__other")).toEqual([]);
 expect(renterPriceEvidence([receipt("quote_booking_addition",{...native,ok:false})],[],native.thread_id)).toEqual([]);
 expect(renterPriceEvidence([receipt("quote_booking_addition",{...native,quote:{...quote,lines:[quote.lines[0],{...quote.lines[1],line_total_gbp:null}]}})],[],native.thread_id)).toEqual([]);
});


describe("native proposed line prices survive the evidence handoff",()=>{
 const thread="__probe__native-lines";
 const baseName="Blackmagic 6k Full frame cinema camera + 24-105mm Cannon Zoom lens L series";
 const native=()=>({ok:true,preview_only:true,source:"native_lab_proposal",thread_id:thread,account_slug:"leo",
  base_items:[{name:baseName,quantity:1}],added_items:[{name:"Canon EF 16-35mm f2.8",quantity:1}],
  quote:{days:2,start_date:"2026-10-20",end_date:"2026-10-21",total_gbp:164,lines:[
   {name:baseName,product_id:1172450,qty:1,daily_price_gbp:62,effective_rate_gbp:62,line_total_gbp:124},
   {name:"Canon EF 16-35mm f2.8",item_id:"native-lens",qty:1,daily_price_gbp:20,effective_rate_gbp:20,line_total_gbp:40},
  ]}});
 it("proves the add-on rate and line total from the captured native proposal without another lookup",()=>{
  const proof=renterPriceEvidence([receipt("quote_booking_addition",native())],[],thread);
  expect(proof).toContainEqual(expect.objectContaining({kind:"rental",names:["Canon EF 16-35mm f2.8"],quantity:1,days:2,daily_rate_gbp:20,total_gbp:40,start_date:"2026-10-20",end_date:"2026-10-21",source:"native_lab_proposal"}));
  const scope={items:[{name:baseName,quantity:1}],start_date:"2026-10-20",end_date:"2026-10-21"};
  const text="Canon EF 16-35mm f2.8 would cost £20/day (£40 total) for 20 to 21 October. Adding one extra would bring your booking total to £164.";
  expect(unsupportedPriceClaims(text,proof,scope)).toEqual([]);
  for(const changed of [text.replace("£20","£21"),text.replace("£40","£41"),text.replace("Canon EF","Canon RF"),text.replace("21 October","22 October")])
   expect(unsupportedPriceClaims(changed,proof,scope),changed).not.toEqual([]);
 });
 it("binds listing aliases only to the matching native account and product",()=>{
  const names=[{account_slug:"leo",product_id:1172450,names:["BMPCC 6K Full Frame + Canon EF 24-105mm f4"]},{account_slug:"diogo",product_id:1172450,names:["Wrong account kit"]}];
  const proof=renterPriceEvidence([receipt("quote_booking_addition",native())],names,thread);
  expect(proof.find(p=>p.total_gbp===124)?.names).toContain(names[0].names[0]);
  expect(proof.some(p=>p.names.includes("Wrong account kit"))).toBe(false);
 });
 it("rejects changed members, sums, dates and quantities rather than trusting the quoted grand total",()=>{
  for(const mutate of [
   (n:ReturnType<typeof native>)=>{n.quote.total_gbp=163;},
   (n:ReturnType<typeof native>)=>{n.quote.days=3;},
   (n:ReturnType<typeof native>)=>{n.quote.lines[1].qty=2;},
   (n:ReturnType<typeof native>)=>{n.quote.lines[1].name="Sony 16-35mm";},
  ]){const n=native();mutate(n);expect(renterPriceEvidence([receipt("quote_booking_addition",n)],[],thread)).toEqual([]);}
 });
 it("does not mint individual prices from unbound identities or inconsistent rates",()=>{
  for(const mutate of [
   (n:ReturnType<typeof native>)=>{delete n.quote.lines[1].item_id;},
   (n:ReturnType<typeof native>)=>{n.quote.lines[1].effective_rate_gbp=19;},
  ]){const n=native();mutate(n);const proof=renterPriceEvidence([receipt("quote_booking_addition",n)],[],thread);expect(proof.some(p=>p.kind==="rental"&&p.names.includes("Canon EF 16-35mm f2.8"))).toBe(false);}
 });
});

describe("same-item marginal proposal evidence",()=>{
 const thread="__probe__marginal";
 const line={name:"Sony FX3",item_id:"native-camera",product_id:3,qty:1,daily_price_gbp:40,effective_rate_gbp:40,line_total_gbp:80};
 const dated={days:2,start_date:"2026-10-20",end_date:"2026-10-21"};
 const native=()=>({ok:true,preview_only:true,source:"native_lab_proposal",thread_id:thread,account_slug:"leo",
  base_items:[{name:line.name,quantity:1}],added_items:[{name:line.name,quantity:1}],
  quote:{...dated,lines:[{...line,qty:2,line_total_gbp:160}],total_gbp:160},
  base_quote:{...dated,lines:[{...line}],total_gbp:80},addition_quote:{...dated,lines:[{...line}],total_gbp:80},additional_cost_gbp:80});
 const scope={items:[{name:line.name,quantity:1}],start_date:dated.start_date,end_date:dated.end_date};
 const claim="One extra Sony FX3 would cost £80 for 2 days. Adding it would bring your booking total to £160.";
 it("keeps every emitted receipt field and role within the shared backend validator",()=>{
  const root=draftEvidenceValidator.json;
  if(root.type!=="object")throw new Error("Expected object evidence validator");
  const prices=root.value.prices.fieldType;
  if(prices.type!=="array" || prices.value.type!=="object")throw new Error("Expected price objects");
  const fields=prices.value.value;
  const proof=renterPriceEvidence([receipt("quote_booking_addition",native())],[],thread);
  expect(proof.some(p=>p.quote_role==="addition")).toBe(true);
  for(const p of proof)expect(Object.entries(p).filter(([,v])=>v!==undefined).map(([k])=>k).filter(k=>!(k in fields))).toEqual([]);
  expect(fields.quote_role.optional).toBe(true);
  expect(fields.quote_role.fieldType).toEqual({type:"union",value:[{type:"literal",value:"base"},{type:"literal",value:"proposed_line"},{type:"literal",value:"addition"}]});
 });
 it("proves the additional unit, not just the combined two-unit line",()=>{
  const n=native();const proof=renterPriceEvidence([receipt("quote_booking_addition",n)],[],thread);
  expect(proof).toContainEqual(expect.objectContaining({quote_role:"addition",quantity:1,total_gbp:80}));
  expect(unsupportedPriceClaims(claim,proof,scope)).toEqual([]);
  for(const bad of [claim.replace("£80","£160"),claim.replace("£80","£81"),claim.replace("One extra","Two extra")])expect(unsupportedPriceClaims(bad,proof,scope),bad).not.toEqual([]);
 });
 it("does not use the current booked price or combined line as the extra's price",()=>{
  const n=native();const booked=renterPriceEvidence([receipt("get_lab_order",{...n.base_quote})]);
  const combined={...n,base_quote:undefined,addition_quote:undefined,additional_cost_gbp:undefined};
  expect(unsupportedPriceClaims(claim,[...booked,...renterPriceEvidence([receipt("quote_booking_addition",combined)],[],thread)],scope)).not.toEqual([]);
 });
 it("still quotes an already booked extra from the current order receipt",()=>{
  const n=native();const proof=renterPriceEvidence([receipt("get_lab_order",n.base_quote)]);
  expect(unsupportedPriceClaims("Your booked extra Sony FX3 costs £80 for 2 days.",proof,scope)).toEqual([]);
  expect(unsupportedPriceClaims("An extra Sony FX3 would cost £80 for 2 days, like your already booked one.",proof,scope)).not.toEqual([]);
 });
 it("rejects forged deltas, line identities, periods, members and rates",()=>{
  for(const change of [
   (n:ReturnType<typeof native>)=>{n.additional_cost_gbp=81;},
   (n:ReturnType<typeof native>)=>{n.addition_quote.lines[0].item_id="other-camera";},
   (n:ReturnType<typeof native>)=>{n.addition_quote.start_date="2026-10-19";},
   (n:ReturnType<typeof native>)=>{n.addition_quote.lines[0].qty=2;},
   (n:ReturnType<typeof native>)=>{n.addition_quote.lines[0].daily_price_gbp=45;},
   (n:ReturnType<typeof native>)=>{n.base_quote.total_gbp=70;},
  ]){const n=native();change(n);const proof=renterPriceEvidence([receipt("quote_booking_addition",n)],[],thread);expect(proof.some(p=>p.quote_role==="addition")).toBe(false);expect(unsupportedPriceClaims(claim,proof,scope)).not.toEqual([]);}
 });
});


describe("complete multi-item Native addition quotes",()=>{
 const native=jointNativeQuote;
 const scope={start_date:native.quote.start_date,end_date:native.quote.end_date,items:native.base_items};
 const claim="- Blazar Remus 100mm: £50 (£25/day)\n- PL to L mount adapter: £20 (£10/day)\n\nAdding both would be an additional £70, which would bring your total booking to £194.";
 const proof=(n:Record<string,unknown>=native)=>renterPriceEvidence([receipt("quote_booking_addition",n)],[],native.thread_id);
 it("validates actual Native joint quote parts and binds the group cost and proposed full total",()=>{
  const evidence=proof();
  expect(evidence).toContainEqual(expect.objectContaining({kind:"basket",quote_role:"addition",total_gbp:70,items:native.added_items}));
  expect(unsupportedPriceClaims(claim,evidence,scope)).toEqual([]);
  for(const changed of [claim.replace("£70","£71"),claim.replace("£194","£195"),claim.replace("PL to L","PL to E"),claim.replace("Blazar Remus 100mm:","Two Blazar Remus 100mm:"),claim.replace("Blazar Remus 100mm:","Unknown lens:")])
   expect(unsupportedPriceClaims(changed,evidence,scope)).not.toEqual([]);
  expect(unsupportedPriceClaims(claim,evidence,{...scope,end_date:"2026-10-22"})).not.toEqual([]);
 });
 it("rejects another thread, failed proposals, altered groups and inconsistent marginal terms",()=>{
  expect(renterPriceEvidence([receipt("quote_booking_addition",native)],[],"__probe__another")).toEqual([]);
  expect(proof({...native,ok:false})).toEqual([]);
  expect(proof({...native,added_items:[native.added_items[0],native.added_items[0]]})).toEqual([]);
  for(const changed of [{...native,additional_cost_gbp:71},{...native,addition_quote:{...native.addition_quote,total_gbp:71}},
   {...native,addition_quote:{...native.addition_quote,end_date:"2026-10-22"}}]) {
    expect(proof(changed).some(e=>e.kind==="basket"&&e.quote_role==="addition")).toBe(false);
    expect(unsupportedPriceClaims(claim,proof(changed),scope)).not.toEqual([]);
   }
 });
 it("never accepts repeated quoted members in place of the distinct Native group",()=>{
  const repeated=claim.replace("PL to L mount adapter:","Blazar Remus 100mm:").replace("£20 (£10/day)","£50 (£25/day)");
  expect(unsupportedPriceClaims(repeated,proof(),scope)).not.toEqual([]);
  expect(unsupportedPriceClaims(claim.replace("Adding both would","Both now"),proof(),scope)).not.toEqual([]);
 });
 it("keeps the conditional proposal across currency amounts in the same sentence",()=>{
  for(const ending of ["bringing your total to", "taking your updated booking total to", "raising your full booking total to"]){
   const text=claim.replace("which would bring your total booking to",ending);
   expect(unsupportedPriceClaims(text,proof(),scope),text).toEqual([]);
   expect(unsupportedPriceClaims(text.replace("£194","£195"),proof(),scope)).not.toEqual([]);
   expect(unsupportedPriceClaims(text.replace("PL to L","PL to E"),proof(),scope)).not.toEqual([]);
  }
 });
 it("does not carry conditional evidence across sentence, paragraph or semicolon boundaries",()=>{
  for(const separator of [". ","\n\n","; "]){
   const text=claim.replace(", which would bring your total booking to",`${separator}Bringing your total to`);
   expect(unsupportedPriceClaims(text,proof(),scope),text).not.toEqual([]);
  }
  expect(unsupportedPriceClaims(claim.replace("Adding both would be","Adding both is").replace("which would bring your total booking to","bringing your total to"),proof(),scope)).not.toEqual([]);
 });
});
