import { expect,it } from "vitest";
import { guardDraft } from "./draft_guard";
import { lensReadinessSubject } from "./catalogue_readiness";
import { rentalRefusalSubject,unsupportedStockClaims } from "./stock_claims";
const clause="We don't currently have a verified autofocus wide-angle Sony E lens ready to quote immediately";
const evidence=[{subject:lensReadinessSubject({focus_mode:"autofocus",wide_angle:true},"Sony E")!,source_call_id:"native-search"}];
const options={history:[],lastRenterMessage:"Can you check an autofocus wide-angle Sony E lens?",stockEvidence:[],stockRequest:{items:[]},groundedDuringTurn:{unavailability:false}};
it("separates the saved actual model's catalogue readiness claim from physical stock",()=>{
 expect(rentalRefusalSubject(clause)).toBeNull();
 expect(unsupportedStockClaims(clause,[],{items:[]})).toEqual([]);
 const result=guardDraft(clause+".",{...options,catalogueReadinessEvidence:evidence});
 expect(result.flags.filter(f=>f.type.startsWith("UNGROUNDED_"))).toEqual([]);
});
it("requires current independent evidence for the exact capability class",()=>{
 for(const receipts of [[],[{...evidence[0],subject:"manual focus wide angle e lens"}],[{...evidence[0],source_call_id:""}]]) {
  expect(guardDraft(clause+".",{...options,catalogueReadinessEvidence:receipts}).flags).toContainEqual(expect.objectContaining({type:"UNGROUNDED_CATALOGUE_READINESS",severity:"critical"}));
 }
 expect(lensReadinessSubject({focus_mode:"autofocus",wide_angle:true,max_aperture_f:2.8},"E")).toBeNull();
});
it("keeps physical refusals and mixed positive/negative stock claims gated",()=>{
 for(const text of ["We don't have an autofocus wide-angle Sony E lens.","We don't have a verified autofocus wide-angle Sony E lens.",clause+". Sony FX3 is unavailable.",clause+", but Sony FX3 is available.","We don't have a verified booked out Sony E lens ready to quote."]) {
  const flags=guardDraft(text,{...options,catalogueReadinessEvidence:evidence}).flags;
  expect(flags.some(f=>f.type==="UNGROUNDED_UNAVAILABILITY"||f.type==="UNGROUNDED_AVAILABILITY")).toBe(true);
 }
});
