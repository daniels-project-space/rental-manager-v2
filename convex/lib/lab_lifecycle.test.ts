import { describe, expect, it } from "vitest";
import { labBooking } from "./lab_lifecycle";
import { rentalStage } from "./rental_stage";
describe("real Lab lifecycle facts", () => {
 it("seeds actual booking state rather than an LLM conversation label", () => {
  const expected = { inquiry: "INQUIRY", awaiting_owner_approval: "AWAITING_OWNER_APPROVAL", awaiting_payment: "AWAITING_PAYMENT", awaiting_verification: "AWAITING_VERIFICATION", confirmed: "CONFIRMED_UPCOMING", in_use: "IN_USE", completed: "COMPLETED", cancelled: "CANCELLED" };
  for (const [state, stage] of Object.entries(expected)) expect(rentalStage(labBooking(state, "2026-10-02", "2026-10-04"), "2026-10-01").stage).toBe(stage);
 });
 it("does not invent a return from a passed end date", () => {
  expect(rentalStage(labBooking("in_use", "2026-09-28", "2026-09-30"), "2026-10-01").stage).toBe("RETURN_OVERDUE");
 });
 it("rejects fake or undated booked stages", () => {
  expect(() => labBooking("paid-ish", "2026-10-02", "2026-10-04")).toThrow();
  expect(() => labBooking("confirmed")).toThrow();
 });
});
