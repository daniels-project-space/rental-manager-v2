import pairedNative from "./fixtures/renter-sales-paired-native.json";
import {unsupportedPriceClaims,type PriceEvidence} from "../../convex/lib/price_claims";
import {renterPriceEvidence} from "./renter-price-evidence";
import { describe, expect, it } from "vitest";
import { recommendationKitEvidence, renterToolReceipts, stockReceipts, successfulGrounding } from "./renter-tool-evidence";
import { normalizeClaimedFacts } from "../../convex/lib/renter_draft_evidence";
import { unsupportedStockClaims } from "../../convex/lib/stock_claims";
import mismatch from "./fixtures/renter-product-name-mismatch.json";

describe("untrusted claimed-fact diagnostics", () => {
  it("accepts missing call attribution without manufacturing proof or crashing Lab persistence", () => {
    expect(normalizeClaimedFacts([{ kind: "item_included", value: "Battery charger, cables", sourceTool: "preloaded_facts" }]))
      .toEqual([{ kind: "item_included", value: "Battery charger, cables", sourceTool: "preloaded_facts", sourceCallId: "", verified: false }]);
  });
  it("rejects malformed rows and overrides model-supplied verification", () => {
    expect(normalizeClaimedFacts({ kind: "item_included" })).toEqual([]);
    expect(normalizeClaimedFacts([null, { kind: 1, value: "Bad" }, { kind: "spec", value: 42 }])).toEqual([]);
    expect(normalizeClaimedFacts([{ kind: "spec", value: "Claim", verified: true, sourceCallId: 7 }]))
      .toEqual([{ kind: "spec", value: "Claim", sourceTool: "unattributed", sourceCallId: "", verified: false }]);
  });
});

const stock = { available: true, owned: true, item_name: "Sony FX3", start_date: "2026-10-02", end_date: "2026-10-04", requested_units: 1, free_units: 1, checked_at: 12345 };
it("rejects the real Native product-ID/name mismatch instead of harvesting its aggregate echo",()=>{
 const harvested=stockReceipts(renterToolReceipts([{toolName:"check_availability",toolCallId:"captured-native-mismatch",result:mismatch}]));
 expect(harvested.map(r=>r.result.item_name)).not.toContain("Sony FX3");
 expect(harvested.map(r=>r.result.item_name)).toContain("BMPCC 6K Pro");
 const receipts=harvested.map(r=>({item:String(r.result.item_name),start_date:String(r.result.start_date),end_date:String(r.result.end_date),quantity:Number(r.result.requested_units),available:r.result.available as boolean|null,free_units:r.result.free_units as number|null,checked_at:Number(r.result.checked_at),call_id:r.call_id}));
 expect(unsupportedStockClaims("Sony FX3 is available for 20 to 21 October.",receipts,{start_date:"2026-10-20",end_date:"2026-10-21",items:[{name:"BMPCC 6K Full Frame",quantity:1}]})).not.toEqual([]);
});
it("does not turn a failed aggregate proposal into an independent negative camera receipt",()=>{
 const result={...stock,item_name:"BMPCC 6K Pro",available:false,stock_scope:"proposed_basket",components:[{...stock,item_name:"BMPCC 6K Pro"},{...stock,item_name:"NP-F570 batteries",available:false}]};
 expect(stockReceipts(renterToolReceipts([{toolName:"check_availability",result}])).map(r=>[r.result.item_name,r.result.available])).toEqual([["BMPCC 6K Pro",true],["NP-F570 batteries",false]]);
});
describe("successful tool receipts", () => {
  it("carries authoritative alternative kits without accepting call arguments or marketing prose", () => {
    const a = { name: "BMPCC 6K Full Frame", listing_name: "Misleading SEO title", kit_source: "physical_mapping_and_inventory", kit_contents: ["NP-F570 batteries", "1TB CFexpress Type B"] };
    const argsOnly = renterToolReceipts([{ payload: { toolName: "find_owned_alternatives", args: { alternatives: [a] } } }]);
    expect(recommendationKitEvidence(argsOnly)).toEqual([]);
    const receipts = renterToolReceipts([{ payload: { toolName: "find_owned_alternatives", result: { alternatives: [a, { ...a, name: "Unknown kit", kit_source: "unknown", included: "SEO says charger" }] } } }]);
    expect(recommendationKitEvidence(receipts)).toEqual([{ names: ["BMPCC 6K Full Frame", "6K Full Frame", "Blackmagic 6K Full Frame", "Blackmagic Pocket Cinema Camera 6K Full Frame", "Blackmagic Cinema Camera 6K Full Frame", "BMPCC 6K FF", "Blackmagic 6K FF", "6K FF", a.listing_name], contents: a.kit_contents }]);
    expect(recommendationKitEvidence([{...receipts[0],result:{alternatives:[{...a,kind:"camera"}]}}])[0].kind).toBe("camera");
  });
  it("never grounds a call that has no successful result", () => {
    const receipts = renterToolReceipts([{ toolCalls: [{ payload: { toolName: "check_availability", args: stock } }] }]);
    expect(successfulGrounding(receipts).availability).toBe(false);
  });
  it("reads real Mastra nested and older result shapes", () => {
    for (const steps of [[{ type: "tool-result", payload: { toolName: "check_availability", toolCallId: "one", result: stock } }], [{ toolResults: [{ toolName: "check_availability", toolCallId: "one", output: stock }] }]]) {
      expect(renterToolReceipts(steps)[0].call_id).toBe("one");
      expect(successfulGrounding(renterToolReceipts(steps)).availability).toBe(true);
    }
  });
  it("does not authorize positive claims from errors, unknowns or unowned stock", () => {
    for (const result of [{ ...stock, error: "timeout" }, { ...stock, available: null }, { ...stock, owned: false }, { ...stock, found: false }])
      expect(successfulGrounding(renterToolReceipts([{ payload: { toolName: "check_availability", result } }])).availability).toBe(false);
  });
  it("a negative verdict never authorizes a positive verdict", () => {
    const grounded = successfulGrounding(renterToolReceipts([{ payload: { toolName: "check_availability", result: { ...stock, available: false } } }]));
    expect(grounded).toMatchObject({ availability: false, unavailability: true });
  });
  it("knowledge and failed pricing searches are not stock or price evidence", () => {
    const receipts = renterToolReceipts([{ payload: { toolName: "search_knowledge", result: { price: 20 } } }, { payload: { toolName: "lookup_pricing", result: { found: false } } }]);
    expect(successfulGrounding(receipts)).toEqual({ availability: false, unavailability: false, price: false, specs: false });
  });
  it("keeps date-checked alternatives scoped to the checked option", () => {
    const receipts = renterToolReceipts([{ payload: { toolName: "find_owned_alternatives", toolCallId: "alternatives", result: { alternatives: [{ name: "Sony FX3", availability: { ...stock, quantity: 2 } }, { name: "Sony A7 III", availability: null }] } } }]);
    expect(successfulGrounding(receipts).availability).toBe(true);
    expect(receipts.filter((r) => r.tool === "check_availability")).toHaveLength(1);
    expect(receipts[1].result.requested_units).toBe(2);
  });
  it("keeps successful stock proof from a simulated order change", () => {
    const receipts = renterToolReceipts([{ payload: { toolName: "modify_booking", toolCallId: "change", result: { ok: true, stock_receipt: stock } } }]);
    expect(successfulGrounding(receipts).availability).toBe(true);
    expect(receipts[1].call_id).toBe("change:mutation-stock");
  });
  it("retains independently checked stock from a rejected amendment without claiming a successful edit", () => {
    const receipts = renterToolReceipts([{ payload: { toolName: "modify_booking", toolCallId: "amend", result: { ok: false, error: "No dates changed", stock_receipts: [{ ...stock, item_id: "camera", available: false, source: "shared_inventory_confirmed_rentals" }] } } }]);
    expect(receipts.some(r => r.tool === "modify_booking")).toBe(false);
    expect(successfulGrounding(receipts)).toMatchObject({ availability: false, unavailability: true });
    expect(stockReceipts(receipts)[0].call_id).toBe("amend:amendment-stock:camera");
    expect(renterToolReceipts([{ payload: { toolName: "modify_booking", args: { stock_receipts: [stock] } } }])).toEqual([]);
  });
  it("drops partial telemetry and duplicate receipt events before persistence", () => {
    const steps = [{ payload: { toolName: "check_availability", toolCallId: "one", result: stock } }, { payload: { toolName: "check_availability", toolCallId: "one", result: { ...stock } } }, { payload: { toolName: "check_availability", toolCallId: "one", result: { toolCallId: "one" } } }];
    expect(stockReceipts(renterToolReceipts(steps))).toHaveLength(1);
    expect(successfulGrounding(renterToolReceipts(steps)).availability).toBe(true);
  });
  it("retains independent stock receipts inside a whole-kit result", () => {
    const steps = [{ payload: { toolName: "check_availability", toolCallId: "kit", result: { ...stock, item_name: "Two camera kit", available: false, components: [{ ...stock, item_id: "camera", requested_units: 2, available: false }, { ...stock, item_name: "Sony GM 24-70", item_id: "lens", requested_units: 2 }] } } }];
    const receipts = stockReceipts(renterToolReceipts(steps));
    expect(receipts).toHaveLength(3);
    expect(receipts.map((r) => r.result.item_name)).toEqual(["Two camera kit", "Sony FX3", "Sony GM 24-70"]);
    expect(receipts[1].result.requested_units).toBe(2);
  });

});


it("carries the alternative's native item kind into stock evidence without borrowing the model's category",()=>{
 const receipts=renterToolReceipts([{payload:{toolName:"find_owned_alternatives",toolCallId:"lens",args:{kind:"camera"},result:{alternatives:[{name:"Canon EF 16-35mm f2.8",kind:"lens",availability:{...stock,quantity:1}}]}}}]);
 expect(stockReceipts(receipts)[0].result).toMatchObject({item_name:"Canon EF 16-35mm f2.8",kind:"lens",requested_units:1});
 const noKind=renterToolReceipts([{payload:{toolName:"find_owned_alternatives",toolCallId:"unknown",args:{kind:"lens"},result:{alternatives:[{name:"Unknown item",availability:{...stock,quantity:1}}]}}}]);
 expect(stockReceipts(noKind)[0].result.kind).toBeUndefined();
});

it("retains Native failed recommendation basket checks without a positive alternative",()=>{
  const stock={source:"shared_inventory_confirmed_rentals",item_id:"pro",item_name:"BMPCC 6K Pro",kind:"camera",available:false,owned:true,requested_units:2,free_units:1,start_date:"2026-10-20",end_date:"2026-10-21",checked_at:123};
  const result={count:0,alternatives:[],rejected_stock_options:[{name:"BMPCC 6K Pro",booking_use:"additional",stock_receipts:[stock]}]};
  const receipts=renterToolReceipts([{toolName:"find_owned_alternatives",toolCallId:"recommend",result}]);
  expect(stockReceipts(receipts).map(r=>r.result)).toEqual([stock]);
  expect(successfulGrounding(receipts)).toMatchObject({availability:false,unavailability:true});
  expect(renterToolReceipts([{toolName:"find_owned_alternatives",args:result}])).toEqual([]);
});

it("retains joint Native component proofs while ignoring proposed model arguments",()=>{
 const basket={available:false,items:[{name:"NP-F570 batteries",quantity:15}]};
 const component={...stock,item_name:"NP-F570 batteries",requested_units:15,available:false,free_units:12,basket,source:"shared_inventory_confirmed_rentals"};
 const steps=[{toolName:"check_basket_availability",toolCallId:"joint",args:{components:[{...component,available:true}]},result:{available:false,components:[component]}}];
 expect(stockReceipts(renterToolReceipts(steps))).toHaveLength(1);
 expect(stockReceipts(renterToolReceipts(steps))[0].result).toEqual(component);
 expect(stockReceipts(renterToolReceipts([{toolName:"check_basket_availability",args:{components:[component]}}]))).toEqual([]);
});

describe("captured paired lens sales reply",()=>{
 const receipts=(native=pairedNative.lens_result)=>renterToolReceipts([{toolName:"find_owned_alternatives",toolCallId:"native-reviewed",result:native}]);
 const stock=(native=pairedNative.lens_result)=>stockReceipts(receipts(native)).map(r=>({item:r.result.item_name as string,quantity:r.result.requested_units as number,start_date:r.result.start_date as string,end_date:r.result.end_date as string,available:r.result.available as boolean,free_units:r.result.free_units as number,call_id:r.call_id,checked_at:r.result.checked_at as number,kind:r.result.kind as string,identity_names:r.result.identity_names as string[]}));
 const check=(text=pairedNative.candidate,evidence=[...pairedNative.stock,...stock()])=>unsupportedStockClaims(text,evidence,pairedNative.request,["Canon R5"],pairedNative.renter_message);
 it("retains the reviewed lens family through actual tool receipt harvesting and joint stock checks",()=>{
  expect(stock()[0].identity_names).toContain("Sony FE 16-35mm F2.8 GM");
  expect(stock()[0].identity_names).not.toContain("SEL1635GM2");
  expect(check()).toEqual([]);
  expect(check("Sony FE 16-35mm f/2.8 GM wide-angle autofocus zoom is available for 20 to 21 October.")).toEqual([]);
  expect(unsupportedPriceClaims(pairedNative.candidate,pairedNative.prices as PriceEvidence[],pairedNative.request,pairedNative.renter_message)).toEqual([]);
  const reviewedPrice=renterPriceEvidence(receipts());
  expect(unsupportedPriceClaims("Sony FE 16-35mm f/2.8 GM costs £40 for 2 days.",reviewedPrice,pairedNative.request)).toEqual([]);
  expect(unsupportedPriceClaims("Sony FE 16-35mm f/2.8 GM II costs £40 for 2 days.",reviewedPrice,pairedNative.request)).not.toEqual([]);
 });
 it("does not invent the reviewed identity from advertising, missing or mismatched spec records",()=>{
  const alternative=pairedNative.lens_result.alternatives[0];
  for(const patch of [{spec_verification:null},{lens_capabilities:null},{spec_verification:{...alternative.spec_verification,model:"Other lens"}},{spec_verification:{...alternative.spec_verification,source_url:"https://other.example"}},{lens_capabilities:{...alternative.lens_capabilities,reviewed_models:[]}}]) {
   const native={...pairedNative.lens_result,alternatives:[{...alternative,...patch}]} as typeof pairedNative.lens_result;
   expect(stock(native)[0].identity_names).not.toContain("Sony FE 16-35mm F2.8 GM");
   expect(check(pairedNative.candidate,[...pairedNative.stock,...stock(native)])).not.toEqual([]);
  }
 });
 it("keeps wrong mount, model generation, aperture, focal range, quantity and joint verdict unverified",()=>{
  for(const label of ["Canon RF 16-35mm f/2.8 GM wide-angle autofocus zoom","Sony FE 16-35mm f/2.8 GM II wide-angle autofocus zoom","Sony FE 16-35mm f/4 GM wide-angle autofocus zoom","Sony FE 16mm f/2.8 GM wide-angle autofocus zoom","Sony FE 24-70mm f/2.8 GM wide-angle autofocus zoom","two Sony FE 16-35mm f/2.8 GM wide-angle autofocus zoom"])
   expect(check(pairedNative.candidate.replace("Sony FE 16-35mm f/2.8 GM wide-angle autofocus zoom",label)),label).not.toEqual([]);
  expect(check(pairedNative.candidate,[...pairedNative.stock.map(r=>({...r,basket:{...r.basket,available:false}})),...stock()])).not.toEqual([]);
 });
 it("does not confuse the camera's parenthesized contents with a combined lens price",()=>{
  for(const changed of [pairedNative.candidate.replace("£40","£41"),pairedNative.candidate.replace("16-35mm f/2.8 GM is","Canon RF 16-35mm f/2.8 GM is"),pairedNative.candidate.replace("£138","£139")])expect(unsupportedPriceClaims(changed,pairedNative.prices as PriceEvidence[],pairedNative.request,pairedNative.renter_message)).not.toEqual([]);
  const nested=pairedNative.candidate.replace("(includes 2x NP-FZ100 battery sets and a CFexpress Type A card)","(includes batteries (two sets) and a card)");
  expect(unsupportedPriceClaims(nested,pairedNative.prices as PriceEvidence[],pairedNative.request,pairedNative.renter_message)).toEqual([]);
 });
});
