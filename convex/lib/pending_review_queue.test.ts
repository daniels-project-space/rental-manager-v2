import { describe, expect, it } from "vitest";
import {
  isAwaitingOwnerReply,
  isClosedRentalLifecycle,
  isOpenPendingReviewBooking,
  needsOwnerReply,
} from "./pending_review_queue";

describe("pending-review queue qualification", () => {
  it("does not count failed, canceled, completed, or obsolete bookings as awaiting confirmation", () => {
    expect(isOpenPendingReviewBooking({ status: "pending_review", order_step: "VERIFICATION_FAILED" }, "2026-10-16", "12:00")).toBe(false);
    expect(isOpenPendingReviewBooking({ status: "pending_review", order_step: "CANCELED" }, "2026-10-16", "12:00")).toBe(false);
    expect(isOpenPendingReviewBooking({ status: "pending_review", order_step: "REVIEWED" }, "2026-10-16", "12:00")).toBe(false);
    expect(isOpenPendingReviewBooking({ status: "pending_review", is_obsolete: true }, "2026-10-16", "12:00")).toBe(false);
  });

  it("keeps requests until their requested return date and time has passed", () => {
    const row = { status: "pending_review", start_date: "2026-10-16", end_date: "2026-10-17", return_time: "10:30" };
    expect(isOpenPendingReviewBooking(row, "2026-10-17", "10:29")).toBe(true);
    expect(isOpenPendingReviewBooking(row, "2026-10-17", "10:30")).toBe(false);
    expect(isOpenPendingReviewBooking({ ...row, end_date: "2026-10-15" }, "2026-10-16", "12:00")).toBe(false);
  });

  it("reappears when the renter sends a new message and clears after an owner reply", () => {
    expect(needsOwnerReply({ last_sender: "renter" })).toBe(true);
    expect(needsOwnerReply({ last_sender: "owner" })).toBe(false);
    expect(needsOwnerReply(null)).toBe(false);
  });

  it("uses the same booking lifecycle rules for the inbox and pending-review count", () => {
    expect(needsOwnerReply(null, { status: "pending_review" })).toBe(true);
    expect(needsOwnerReply({ last_sender: "owner" }, { status: "pending_review" })).toBe(false);
    expect(needsOwnerReply({ human_requested: true, last_sender: "owner" }, { status: "confirmed" })).toBe(true);
    expect(isAwaitingOwnerReply({ is_request: true, order_step: "CANCELED" })).toBe(false);
    expect(isClosedRentalLifecycle({ status: "declined" })).toBe(true);
  });
});
