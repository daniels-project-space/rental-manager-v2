import {it,expect} from "vitest";
import fixture from "../../src/lib/fixtures/renter-swap-comparison.json";
import {unrelatedToRenderedReplacement} from "./owner_check_scope";
import type {PriceEvidence} from "./price_claims";
it("keeps a price-only reply independent of unrelated camera research without suppressing relevant owner work",()=>{
 const input={kind:"camera_recommendation",candidateNames:["Sony FX3","BMPCC 6K Full Frame"],flags:[{type:"NATIVE_REPLACEMENT_QUOTE_RENDERED"}],prices:fixture.evidence as PriceEvidence[]};
 expect(unrelatedToRenderedReplacement(input)).toBe(true);
 expect(unrelatedToRenderedReplacement({...input,candidateNames:["Sony A7 III"]})).toBe(false);
 expect(unrelatedToRenderedReplacement({...input,candidateNames:[]})).toBe(false);
 expect(unrelatedToRenderedReplacement({...input,flags:[]})).toBe(false);
 expect(unrelatedToRenderedReplacement({...input,kind:"kit_contents"})).toBe(false);
});
