import {describe,expect,it} from "vitest";
import {componentStockContext} from "./renter_stock_prompt";
describe("component stock context",()=>{
 const component={item_name:"Sony NP-FZ100 batteries",available:true,requested_units:3,free_units:12};
 it("identifies a confirmed lower bound without presenting it as a ceiling",()=>{
  const text=componentStockContext({...component,quantity_basis:{basis:"owner_lower_bound"}},"2026-11-26","2026-11-26");
  expect(text).toContain("at least 12 units known free; exact total unknown");
  expect(text).toContain("verdict applies only to the checked quantity");
  expect(text).toContain("Do not infer a shortage");
 });
 it("preserves an exact count and an unknown verdict",()=>{
  expect(componentStockContext(component,"2026-11-26","2026-11-26")).toContain("12 units free");
  expect(componentStockContext({...component,available:null,free_units:null},"2026-11-26","2026-11-26")).toContain("UNKNOWN; requested 3, free count unknown");
 });
 it("passes a verified dated reason without turning it into a pickup-location explanation",()=>{
  const text=componentStockContext({...component,available:false,free_units:0,renter_safe_availability_note:"Some units are already booked during part of the requested period."},"2026-11-26","2026-11-26");
  expect(text).toContain("Verified date-specific reason: Some units are already booked");
  expect(text).toContain("do not use it to explain a different pickup location");
 });
 it("does not invent a renter-facing explanation when the exact reason is unknown",()=>{
  const text=componentStockContext({...component,available:false,free_units:0},"2026-11-26","2026-11-26");
  expect(text).not.toContain("repair");
  expect(text).not.toContain("already booked");
 });
});
