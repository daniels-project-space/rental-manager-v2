import {describe,it,expect} from "vitest";
import {renterRequestsReadOnly,renterProhibitsItemChange} from "./renter_booking_consent";
const actions=["add_item","remove_item","set_dates"] as const;
describe("server message restrictions",()=>{
 it("keeps quote-only and no-booking-change messages read-only for every edit",()=>{
  for(const text of ["Quote only, do not change my booking.","Just a quote please.","Only an estimate please.","Don't edit anything yet.","Please quote it first.","No booking changes.","Don’t make any changes to my booking.","Please price it without making any changes.","Leave my booking unchanged.","Can you add the lens? Quote only for now."])
   for(const action of actions)expect(renterRequestsReadOnly(text,action),text).toBe(true);
 });
 it("does not turn a pricing question into an edit",()=>{
  for(const text of ["How much for another FX3?","Could you quote one extra body?","Before I decide, what would it cost?"])
   for(const action of actions)expect(renterRequestsReadOnly(text,action),text).toBe(true);
 });
 it("preserves explicit instructions and confirmation",()=>{
  for(const text of ["Please add the Sony FX3.","Yes please, add it.","Can you remove the Canon lens?","Please move the booking to 20 October.","How much for the FX3? Please add it."])
   expect(renterRequestsReadOnly(text,"add_item"),text).toBe(false);
 });
 it("keeps action-specific prohibitions from blocking another requested action",()=>{
  expect(renterRequestsReadOnly("Don't remove anything; please add the Sony FX3.","add_item")).toBe(false);
  expect(renterRequestsReadOnly("Don't remove anything; please add the Sony FX3.","remove_item")).toBe(true);
  expect(renterRequestsReadOnly("Don't change the dates; please add the lens.","add_item")).toBe(false);
  expect(renterRequestsReadOnly("Don't change the dates; please add the lens.","set_dates")).toBe(true);
 });
});

describe("named restrictions use Native item identity",()=>{
 const inventory=[{id:"lens",name:"Anamorphic Blazar Remus 100mm",aliases:["Blazar Remus 100mm"],kind:"lens"},{id:"adapter",name:"PL to L mount",aliases:["PL to L mount adapter"],kind:"accessory"},{id:"other",name:"Sony FX3",aliases:["FX 3"],kind:"camera_body"}];
 it("refuses named and category restrictions for the actual selected item",()=>{
  for(const text of ["Please don't add the Blazar Remus 100mm or the PL to L mount adapter.","Do not include your PL to L mount adapter.","I don't want you to add the Blazar Remus 100mm.","Never add extra lenses.","I asked you not to add the Blazar Remus 100mm.","I do not want the Blazar Remus 100mm added.","Leave out the Blazar Remus 100mm.","Hold off on adding the Blazar Remus 100mm."]){expect(renterProhibitsItemChange(text,"add_item",inventory,["lens","adapter"]),text).toBe(true);}
 });
 it("keeps a prohibited adapter out of an independently requested lens-only addition",()=>{
  for(const text of ["Don't add the PL to L mount adapter. Please add the Blazar Remus 100mm.","Don't add your adapter—I already have my own. Add the lens.","Don't add your adapter because I have my own. Please add the lens.","Don't add your adapter, add the lens."]){expect(renterProhibitsItemChange(text,"add_item",inventory,["lens"]),text).toBe(false);}
 });
 it("does not mix another model or another action into the restriction",()=>{
  expect(renterProhibitsItemChange("Don't add the Sony FX3; add the Blazar Remus 100mm.","add_item",inventory,["lens"])).toBe(false);
  expect(renterProhibitsItemChange("Don't remove the Blazar Remus 100mm. Please add it.","add_item",inventory,["lens"])).toBe(false);
  expect(renterProhibitsItemChange("Don't remove the FX 3. Remove the Blazar Remus 100mm.","remove_item",inventory,["lens"])).toBe(false);
  expect(renterProhibitsItemChange("Don't remove the FX 3.","remove_item",inventory,["other"])).toBe(true);
  expect(renterProhibitsItemChange("Keep the FX 3 in my booking.","remove_item",inventory,["other"])).toBe(true);
  expect(renterProhibitsItemChange("I don't want the FX 3 removed.","remove_item",inventory,["other"])).toBe(true);
 });
 it("requires clarification for an unresolved prohibited target and preserves ordinary agreement",()=>{
  expect(renterProhibitsItemChange("Don't add the mystery cinema unit.","add_item",inventory,["lens"])).toBe(true);
  expect(renterProhibitsItemChange("Yes please, add the lens and adapter together.","add_item",inventory,["lens","adapter"])).toBe(false);
 });
});
