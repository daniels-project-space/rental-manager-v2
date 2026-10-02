import {describe,expect,it} from "vitest";
import {explicitRecommendationUse,recommendationBasket} from "./recommendation_basket";
const ff={name:"Full Frame + Canon kit",qty:1,product_id:1172450};
const pro={name:"Pro body kit",qty:1,product_id:1172895};
const ctx={requires_booking_context:true,open_basket:true,can_replace:true};
describe("recommendation stock uses the intended basket",()=>{
  it("retains both existing kits for an addition",()=>{
    expect(recommendationBasket([ff,pro],pro,{...ctx,booking_use:"additional"}).lines).toEqual([ff,pro,pro]);
  });
  it("cannot bypass a confirmed basket through standalone or omitted use",()=>{
    for(const booking_use of [undefined,"standalone"] as const)
      expect(recommendationBasket([ff,pro],pro,{...ctx,booking_use})).toMatchObject({ok:false,reason:"choose_addition_or_exact_replacement"});
  });
  it("replaces exact listing units while preserving unrelated and remaining units",()=>{
    expect(recommendationBasket([ff,pro],pro,{...ctx,booking_use:"replacement",replace_product_id:1172450})).toMatchObject({ok:true,lines:[pro,pro],removed:[ff]});
    expect(recommendationBasket([{...ff,qty:2},pro],pro,{...ctx,booking_use:"replacement",replace_product_id:1172450})).toMatchObject({ok:true,lines:[ff,pro,pro],removed:[ff]});
  });
  it("cannot release a kit by name, unknown product or ambiguous commercial line",()=>{
    for(const replace_product_id of [undefined,999])
      expect(recommendationBasket([ff],pro,{...ctx,booking_use:"replacement",replace_product_id}).ok).toBe(false);
    expect(recommendationBasket([ff,ff],pro,{...ctx,booking_use:"replacement",replace_product_id:1172450}).ok).toBe(false);
  });
  it("cannot release more units than booked or fractional units",()=>{
    for(const replace_quantity of [0,2,1.5])
      expect(recommendationBasket([ff],pro,{...ctx,booking_use:"replacement",replace_product_id:1172450,replace_quantity}).ok).toBe(false);
  });
  it("does not release in-use kit stock before return confirmation",()=>{
    expect(recommendationBasket([ff],pro,{...ctx,booking_use:"replacement",replace_product_id:1172450,can_replace:false})).toMatchObject({ok:false,reason:"replacement_requires_return_confirmation"});
  });
  it("keeps a new inquiry standalone and does not replace a closed basket",()=>{
    const inquiry={requires_booking_context:false,open_basket:false,can_replace:true};
    expect(recommendationBasket([ff],pro,inquiry)).toMatchObject({ok:true,use:"standalone",lines:[pro]});
    expect(recommendationBasket([ff],pro,{...inquiry,booking_use:"replacement",replace_product_id:1172450})).toMatchObject({ok:false,reason:"replacement_requires_open_basket"});
  });
  it("does not treat an unmapped confirmed basket as empty or mutate booked lines",()=>{
    expect(recommendationBasket([],pro,{...ctx,booking_use:"additional"})).toMatchObject({ok:false,reason:"current_basket_unmapped"});
    const lines=Object.freeze([Object.freeze({...ff,qty:2}),Object.freeze({...pro})]);
    recommendationBasket([...lines],pro,{...ctx,booking_use:"replacement",replace_product_id:1172450});
    expect(lines[0].qty).toBe(2);
  });
});

it("does not use a declared replacement to bypass an explicit additional request",()=>{
  const expected_use=explicitRecommendationUse("Quote only: I need an additional cinema camera alongside both cameras already booked.");
  expect(expected_use).toBe("additional");
  expect(recommendationBasket([ff,pro],pro,{...ctx,expected_use,booking_use:"replacement",replace_product_id:1172450})).toMatchObject({ok:false,reason:"recommendation_use_conflicts_with_latest_request"});
  expect(recommendationBasket([ff,pro],pro,{...ctx,expected_use}).lines).toEqual([ff,pro,pro]);
  expect(explicitRecommendationUse("Could I add another camera, or replace my booked kit instead?")).toBeUndefined();
  expect(explicitRecommendationUse("Suggest a replacement for the Full Frame kit.")).toBe("replacement");
});
