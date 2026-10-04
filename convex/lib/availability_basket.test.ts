import { describe,it,expect } from "vitest";
import { availabilityBasket } from "./availability_basket";
const existing=[{name:"Full Frame kit",qty:1,product_id:10},{name:"Pro kit",qty:1,product_id:20}];
const context={requires_booking_context:true,open_basket:true,can_replace:true};
describe("availability basket scope",()=>{
  it('checks a separate hire without adding to or removing the existing basket',()=>{
    const candidate={name:'FX3',qty:1,product_id:30};
    expect(availabilityBasket(existing,candidate,{...context,can_replace:false,booking_use:'separate'})).toMatchObject({ok:true,use:'separate',lines:[candidate],removed:[]});
    expect(existing).toHaveLength(2);
  });
  it("counts the complete existing basket for current gear without adding another unit",()=>{
    const result=availabilityBasket(existing,{name:"Pro",qty:1,product_id:20},{...context,booking_use:"current",expected_use:"additional",current_context:true});
    expect(result.ok).toBe(true);expect(result.lines).toEqual(existing);expect(existing).toHaveLength(2);
  });
  it("infers an additional request and retains every existing line",()=>{
    const candidate={name:"Pro",qty:1,product_id:20};
    expect(availabilityBasket(existing,candidate,{...context,expected_use:"additional"}).lines).toEqual([...existing,candidate]);
  });
  it("refuses standalone checks that bypass a confirmed basket",()=>{
    expect(availabilityBasket(existing,{name:"Pro",qty:1,product_id:20},{...context,booking_use:"standalone"}).ok).toBe(false);
  });
  it("refuses model current-gear checks when the latest request proposes an addition",()=>{
    expect(availabilityBasket(existing,{name:"Pro",qty:1,product_id:20},{...context,booking_use:"current",expected_use:"additional"}).ok).toBe(false);
  });
  it("requires current listing identity and a quantity already on the booking",()=>{
    for(const candidate of [{name:"Pro",qty:1,product_id:30},{name:"Pro",qty:2,product_id:20}])
      expect(availabilityBasket(existing,candidate,{...context,booking_use:"current"}).ok).toBe(false);
  });
  it("replaces only the selected commercial listing and retains the other kit",()=>{
    const result=availabilityBasket(existing,{name:"FX3",qty:1,product_id:30},{...context,booking_use:"replacement",replace_product_id:20});
    expect(result.lines).toEqual([existing[0],{name:"FX3",qty:1,product_id:30}]);expect(result.removed).toEqual([existing[1]]);
  });
});
