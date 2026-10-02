import {describe,it,expect} from "vitest";
import {forbiddenFulfillmentClaims} from "./fulfillment_claims";
const blocked=["RED Komodo"],known=["RED Komodo","Sony FX3"];
describe("item-scoped fulfillment assertions",()=>{
 it.each([
  "The RED Komodo isn't available, but the Sony FX3 is available.",
  "The RED Komodo is not available. I've got the Sony FX3 if that works.",
  "The RED Komodo isn't available. Feel free to book the Sony FX3 instead.",
  "The RED Komodo isn't available. I can rent the Sony FX3 instead.",
  "The RED Komodo isn't available. The Sony FX3 is available; that one is ready for you.",
  "The RED Komodo is unavailable. I don't have it for those dates.",
 ])("preserves an independently checked alternative or decline: %s",text=>expect(forbiddenFulfillmentClaims(text,blocked,known)).toEqual([]));
 it.each([
  "The RED Komodo is available, but the Sony FX3 isn't available.",
  "The RED Komodo is not available today. The RED Komodo is available tomorrow.",
  "Yes, it's available for those dates.",
  "I've got one ready for you.",
  "I can rent the RED Komodo for those dates.",
  "Feel free to book the RED Komodo.",
  "The RED Komodo isn't available. The Sony FX3 is available. Your booking is confirmed.",
 ])("catches explicit and generic false fulfilment: %s",text=>expect(forbiddenFulfillmentClaims(text,blocked,known)).toContain("RED Komodo"));
 it("preserves exact variants and decimal lens models",()=>{
  expect(forbiddenFulfillmentClaims("The Sony FX3 is available.",["Sony FX30"],["Sony FX3"])).toEqual([]);
  expect(forbiddenFulfillmentClaims("The Sony FX30 is available.",["Sony FX30"],["Sony FX3"])).toContain("Sony FX30");
  expect(forbiddenFulfillmentClaims("The Sony 24-70mm f2.8 is available.",["Sony 24-70mm f2.8"],[])).toContain("Sony 24-70mm f2.8");
 });
});
