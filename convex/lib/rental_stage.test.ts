import { describe, it, expect } from "vitest";
import { rentalStage } from "./rental_stage";

const today = "2026-10-01";
describe("authoritative rental stages", () => {
  it("keeps a fresh inquiry unconfirmed", () => {
    expect(rentalStage(null, today).stage).toBe("INQUIRY");
    expect(rentalStage(null, today).can_share_pickup_address).toBe(false);
  });
  it.each(["APPROVED", "FUNDS_RESERVED"])("%s is waiting for payment, not already paid", (order_step) => {
    const stage = rentalStage({ status: "pending_review", order_step }, today);
    expect(stage.stage).toBe("AWAITING_PAYMENT");
    expect(stage.booking_confirmed).toBe(false);
  });
  it("REQUEST awaits owner approval, VERIFIED awaits renter verification", () => {
    expect(rentalStage({ status: "pending_review", order_step: "REQUEST" }, today).stage).toBe("AWAITING_OWNER_APPROVAL");
    expect(rentalStage({ status: "pending_review", order_step: "VERIFIED" }, today).stage).toBe("AWAITING_VERIFICATION");
  });
  it("does not assume the gear was picked up from today's date", () => {
    expect(rentalStage({ status: "confirmed", order_step: "DELIVERED", start_date: today }, today).stage).toBe("COLLECTION_DUE");
  });
  it("RETURNED means return is next to do, not that gear is back", () => {
    expect(rentalStage({ status: "confirmed", order_step: "RETURNED", end_date: "2026-10-02" }, today).stage).toBe("IN_USE");
  });
  it("never declares a past-end rental returned without a completion signal", () => {
    expect(rentalStage({ status: "confirmed", order_step: "RETURNED", end_date: "2026-09-30" }, today).stage).toBe("RETURN_OVERDUE");
  });
  it("honors the owner's completed status even if the platform step lags", () => {
    expect(rentalStage({ status: "completed", order_step: "RETURNED" }, today).stage).toBe("COMPLETED");
  });
  it("confirmed future collection permits the exact address", () => {
    const stage = rentalStage({ status: "confirmed", order_step: "BOOKED_AFTER_VERIFIED", start_date: "2026-10-02" }, today);
    expect(stage.stage).toBe("CONFIRMED_UPCOMING");
    expect(stage.can_share_pickup_address).toBe(true);
  });
  it("failure and obsolete signals override stale confirmation", () => {
    expect(rentalStage({ status: "confirmed", order_step: "VERIFICATION_FAILED" }, today).booking_confirmed).toBe(false);
    expect(rentalStage({ status: "confirmed", is_obsolete: true }, today).can_share_pickup_address).toBe(false);
  });
  it("does not invent a next action from an incomplete pending row", () => {
    expect(rentalStage({ status: "pending_review" }, today).stage).toBe("UNCONFIRMED");
  });
});
