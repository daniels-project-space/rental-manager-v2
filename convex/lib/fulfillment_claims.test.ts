import {describe,it,expect} from "vitest";
import {forbiddenFulfillmentClaims} from "./fulfillment_claims";
import {unsupportedStockClaims} from "./stock_claims";
const blocked=["RED Komodo"],known=["RED Komodo","Sony FX3"];
describe("item-scoped fulfillment assertions",()=>{
 it.each([
  "The RED Komodo isn't available, but the Sony FX3 is available.",
  "The RED Komodo is not available. I've got the Sony FX3 if that works.",
  "The RED Komodo isn't available. Feel free to book the Sony FX3 instead.",
  "The RED Komodo isn't available. I can rent the Sony FX3 instead.",
  "The RED Komodo isn't available, I can offer you the Sony FX3 instead.",
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
  "The RED Komodo isn't available, the Sony FX3 is available, your booking is confirmed.",
 ])("catches explicit and generic false fulfilment: %s",text=>expect(forbiddenFulfillmentClaims(text,blocked,known)).toContain("RED Komodo"));
 it("preserves exact variants and decimal lens models",()=>{
  expect(forbiddenFulfillmentClaims("The Sony FX3 is available.",["Sony FX30"],["Sony FX3"])).toEqual([]);
  expect(forbiddenFulfillmentClaims("The Sony FX30 is available.",["Sony FX30"],["Sony FX3"])).toContain("Sony FX30");
  expect(forbiddenFulfillmentClaims("The Sony 24-70mm f2.8 is available.",["Sony 24-70mm f2.8"],[])).toContain("Sony 24-70mm f2.8");
 });
 it("does not attach an explicitly stated alternative setup to the preceding declined camera",()=>{
  const text="Hi! The Canon R5 kit isn't available for 20–21 October, but for a full-frame 4K walkthrough with autofocus, I can offer our Sony setup:\n\n• Sony FX3 body: £98 for the 2 days (£49/day)\n• Sony GM 16-35mm f/2.8 lens: £40 for the 2 days (£20/day)";
  expect(forbiddenFulfillmentClaims(text,["Canon R5"],["Canon R5","Sony FX3","Sony GM 16-35mm f2.8"])).toEqual([]);
 });
 it.each(["I can offer it.","I can supply one.","I can provide our camera."])("keeps a generic offer bound to its declined item: %s",offer=>{
  expect(forbiddenFulfillmentClaims(`The RED Komodo isn't available. ${offer}`,blocked,known)).toContain("RED Komodo");
 });
 it("leaves an unknown explicit offer ungrounded rather than certifying its stock",()=>{
  const text="The RED Komodo isn't available, but I can offer our Sony setup.";
  expect(forbiddenFulfillmentClaims(text,blocked,known)).toEqual([]);
  expect(unsupportedStockClaims(text,[],{start_date:"2026-10-20",end_date:"2026-10-21",items:[{name:"RED Komodo",quantity:1}]},blocked)).toEqual(expect.arrayContaining([expect.objectContaining({negative:false})]));
 });
});


it("separates a named alternative class from a prior denial without allowing blocked members",()=>{
 const known=["Canon R5","Sony FX3","Sony A7 V"];
 expect(forbiddenFulfillmentClaims("The Canon R5 kit isn't available for 20–21 October, but I have a couple of great full-frame Sony options with autofocus wide-angle glass that fit your budget:",["Canon R5"],known)).toEqual([]);
 for(const text of ["I have a couple of Canon R5 kits.","I have the Sony FX3 and the Canon R5.","I can offer Sony FX3 plus Canon R5.","I can supply Sony FX3 with Canon R5."])expect(forbiddenFulfillmentClaims(text,["Canon R5"],known),text).toContain("Canon R5");
 expect(forbiddenFulfillmentClaims("I have the Sony FX3 instead of the Canon R5.",["Canon R5"],known)).toEqual([]);
});
