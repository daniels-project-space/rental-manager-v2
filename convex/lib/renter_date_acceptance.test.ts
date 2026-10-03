import { describe, expect, it } from "vitest";
import { acceptsDateChange } from "./renter_date_acceptance";
const terms=()=>({context_key:"current",from_start_date:"2026-10-20",from_end_date:"2026-10-21",start_date:"2026-10-20",end_date:"2026-10-22",total_gbp:170,base_total_gbp:124,today:"2026-10-03"});
const owner=()=>({body_text:"I can extend your booking to 20–22 October for £170 total. Shall I update the dates?",quoted_dates:[{...terms(),epoch:86,quoted_for_message_id:"previous",items:[{name:"BMPCC 6K Full Frame",quantity:1}]}]});
describe("date change agreement",()=>{
 for(const text of ["Please extend the return to 22 October at £170 total.","Please move the dates to 20–22 October for £46 extra.","Change the dates to 2026-10-20 to 2026-10-22 at £170."])
  it(`accepts a precise instruction: ${text}`,()=>expect(acceptsDateChange(text,terms())).toBe(true));
 for(const text of ["How heavy is the camera?","Please update my booking.","Please extend it.","Please extend the return to 22 October.","Please move the dates to 20–22 October for £169.99.","Please move the dates to 20–23 October for £170.","If it costs £170 please extend the return to 22 October.","Don't extend the return to 22 October at £170.","Please extend the return to 22 October 2027 at £170.","Please move from 20 October to 22 October for £170."])
  it(`refuses insufficient or conflicting consent: ${text}`,()=>expect(acceptsDateChange(text,terms())).toBe(false));
 for(const text of ["Yes please.","Please extend it.","Go ahead.","Yes, please update the dates."])
  it(`accepts the unchanged sent offer: ${text}`,()=>expect(acceptsDateChange(text,terms(),owner())).toBe(true));
 it("does not require a second confirmation for an explicit no-cost increase instruction",()=>{
  expect(acceptsDateChange("Please extend the return to 22 October.",{...terms(),total_gbp:124})).toBe(true);
 });
 it("rejects changed Native context, dates, prices and multiple offers",()=>{
  for(const change of [{context_key:"stale"},{total_gbp:169.99},{from_end_date:"2026-10-19"},{end_date:"2026-10-23"}]){
   const o=owner();Object.assign(o.quoted_dates[0],change);expect(acceptsDateChange("Yes please.",terms(),o)).toBe(false);
  }
  const o=owner();o.quoted_dates.push({...o.quoted_dates[0]});expect(acceptsDateChange("Yes please.",terms(),o)).toBe(false);
 });
 it("rejects a stored offer contradicted by the sent text",()=>{
  for(const body_text of ["The dates are unavailable for 20–22 October at £170.","I can extend to 20–23 October for £170.","I can extend to 20–22 October for £171.","Either 20–22 October for £170 or another period."])
   expect(acceptsDateChange("Yes please.",terms(),{...owner(),body_text})).toBe(false);
 });
 it("never borrows the model's proposed year for an unqualified date",()=>{
  const t={...terms(),start_date:"2027-10-20",end_date:"2027-10-22"};
  expect(acceptsDateChange("Please move the dates to 20–22 October for £170.",t)).toBe(false);
 });
});
