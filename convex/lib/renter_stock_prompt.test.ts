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
});
